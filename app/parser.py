from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

from .categories import classify_product


def _number(value: Any, default: float = 0) -> float:
    if value is None or isinstance(value, bool):
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def sold_from_text(value: Any) -> int:
    if value is None:
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).casefold().replace("\u00a0", " ")
    match = re.search(r"([0-9][0-9.,]*)\s*(milhões|milhoes|milhão|milhao|mil|mi|k|m)?", text)
    if not match:
        return 0
    raw = match.group(1)
    suffix = match.group(2) or ""
    if "," in raw and "." in raw:
        if raw.rfind(",") > raw.rfind("."):
            raw = raw.replace(".", "").replace(",", ".")
        else:
            raw = raw.replace(",", "")
    elif "," in raw:
        tail = raw.rsplit(",", 1)[1]
        raw = raw.replace(",", ".") if suffix and len(tail) <= 2 else raw.replace(",", "")
    elif "." in raw:
        tail = raw.rsplit(".", 1)[1]
        if not (suffix and len(tail) <= 2):
            raw = raw.replace(".", "")
    number = float(raw)
    if suffix in {"mil", "k"}:
        number *= 1_000
    elif suffix in {"mi", "m", "milhão", "milhao", "milhões", "milhoes"}:
        number *= 1_000_000
    return int(number)


def shopee_money(value: Any) -> float:
    """Shopee APIs normally use 1/100000 BRL, while imports may already be BRL."""
    number = _number(value)
    if abs(number) >= 100_000:
        number /= 100_000
    return round(number, 2)


def timestamp_text(value: Any) -> str | None:
    if isinstance(value, str) and not value.strip().isdigit():
        text = value.strip()
        try:
            return datetime.fromisoformat(text.replace("Z", "+00:00")).isoformat()
        except ValueError:
            return text[:40] or None
    try:
        number = int(value)
        if abs(number) > 10_000_000_000:
            number //= 1000
        brazil_time = timezone(timedelta(hours=-3))
        return datetime.fromtimestamp(number, tz=brazil_time).isoformat()
    except (TypeError, ValueError, OSError):
        return None


def image_url(value: Any) -> str | None:
    """Normalize the different image shapes returned by Shopee list/detail APIs."""
    if not value:
        return None
    if isinstance(value, (list, tuple)):
        for item in value:
            normalized = image_url(item)
            if normalized:
                return normalized
        return None
    if isinstance(value, dict):
        for key in (
            "url", "image_url", "imageUrl", "src", "origin_url", "originUrl",
            "image", "image_id", "imageId", "hash", "md5",
        ):
            if key in value:
                normalized = image_url(value.get(key))
                if normalized:
                    return normalized
        return None
    text = str(value).strip()
    if not text or text.startswith(("data:", "blob:")):
        return None
    if text.startswith("//"):
        return "https:" + text
    if re.match(r"^https?://", text, re.I):
        return text
    if text.startswith("/file/"):
        return "https://down-br.img.susercontent.com" + text
    if text.startswith("file/"):
        text = text[5:]
    return "https://down-br.img.susercontent.com/file/" + text.lstrip("/")


def shopee_product_image(node: dict[str, Any], data: dict[str, Any], asset: dict[str, Any]) -> str | None:
    candidates = (
        asset.get("image"), asset.get("images"), asset.get("image_url"),
        data.get("image"), data.get("images"), data.get("image_url"), data.get("imageUrl"),
        data.get("image_info"), data.get("imageInfo"), data.get("thumbnail"),
        node.get("image"), node.get("images"), node.get("image_url"), node.get("imageUrl"),
    )
    for candidate in candidates:
        normalized = image_url(candidate)
        if normalized:
            return normalized
    return None


def iter_product_nodes(payload: dict[str, Any]) -> Iterable[dict[str, Any]]:
    data = payload.get("data")
    if isinstance(data, dict) and isinstance(data.get("units"), list):
        for unit in data["units"]:
            if isinstance(unit, dict) and isinstance(unit.get("item"), dict):
                yield unit["item"]
    if isinstance(data, dict) and isinstance(data.get("item"), dict):
        yield data["item"]
    if isinstance(data, dict) and isinstance(data.get("items"), list):
        for item in data["items"]:
            if isinstance(item, dict):
                yield item
    if isinstance(data, dict) and (data.get("itemid") is not None or data.get("item_id") is not None):
        yield data
    if isinstance(payload.get("item"), dict):
        yield payload["item"]
    if isinstance(payload.get("items"), list):
        for item in payload["items"]:
            if isinstance(item, dict):
                yield item


def parse_shopee_products(payload: dict[str, Any]) -> list[dict[str, Any]]:
    products: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for node in iter_product_nodes(payload):
        data = node.get("item_data") or node.get("item_basic") or node
        asset = node.get("item_card_displayed_asset") or {}
        item_id = data.get("itemid") or data.get("item_id") or node.get("itemid")
        shop_id = data.get("shopid") or data.get("shop_id") or node.get("shopid")
        if item_id is None or shop_id is None:
            continue
        identity = (str(shop_id), str(item_id))
        if identity in seen:
            continue
        seen.add(identity)
        price_info = data.get("item_card_display_price") or {}
        sold_info = data.get("item_card_display_sold_count") or {}
        rating_info = data.get("item_rating") or {}
        shop_info = data.get("shop_data") or {}
        title = str(asset.get("name") or data.get("name") or node.get("display_name") or "未命名商品")
        category, category_origin = classify_product("shopee", title, node)
        raw_price = price_info.get("price") or (asset.get("display_price") or {}).get("price") or data.get("price") or data.get("price_min")
        historical_text = (sold_info.get("historical_sold_count_text") or
                           sold_info.get("display_sold_count_text") or data.get("historical_sold_text"))
        monthly_text = (sold_info.get("monthly_sold_count_text") or
                        sold_info.get("local_monthly_sold_count_text") or data.get("monthly_sold_text"))
        historical_raw = (sold_info.get("historical_sold_count") or data.get("historical_sold") or
                          data.get("sold"))
        monthly_raw = sold_info.get("monthly_sold_count") or data.get("monthly_sold")
        historical = int(_number(historical_raw)) if historical_raw is not None else sold_from_text(historical_text)
        monthly = int(_number(monthly_raw)) if monthly_raw is not None else sold_from_text(monthly_text)
        counts = rating_info.get("rating_count") or []
        review_count = int(_number(counts[0])) if counts else 0
        created_at = timestamp_text(data.get("ctime"))
        products.append(
            {
                "platform": "shopee",
                "item_id": str(item_id),
                "shop_id": str(shop_id),
                "title": title,
                "category": category,
                "category_origin": category_origin,
                "price": shopee_money(raw_price),
                "historical_sold": historical,
                "monthly_sold": monthly,
                "historical_sold_text": historical_text,
                "monthly_sold_text": monthly_text,
                "historical_sold_estimated": int(historical_raw is None and bool(historical_text)),
                "monthly_sold_estimated": int(monthly_raw is None and bool(monthly_text)),
                "_historical_available": historical_raw is not None or historical_text is not None,
                "_monthly_available": monthly_raw is not None or monthly_text is not None,
                "rating": round(_number(rating_info.get("rating_star")), 3),
                "review_count": review_count,
                "created_at": created_at,
                "shop_name": shop_info.get("shop_name") or data.get("shop_name"),
                "shop_location": shop_info.get("shop_location") or asset.get("shop_location"),
                "product_url": f"https://shopee.com.br/product/{shop_id}/{item_id}",
                "image_url": shopee_product_image(node, data, asset),
                "raw_json": json.dumps(node, ensure_ascii=False),
            }
        )
    return products


def parse_shopee_reviews(payload: dict[str, Any]) -> list[dict[str, Any]]:
    data = payload.get("data") or {}
    ratings = data.get("ratings") if isinstance(data, dict) else None
    if not isinstance(ratings, list):
        return []
    reviews = []
    for item in ratings:
        if not isinstance(item, dict):
            continue
        review_id = item.get("cmtid") or item.get("rating_id") or item.get("orderid")
        if review_id is None:
            continue
        media_count = len(item.get("images") or []) + len(item.get("videos") or [])
        product_items = item.get("product_items") or []
        variant = ""
        if product_items and isinstance(product_items[0], dict):
            variant = str(product_items[0].get("model_name") or "")
        reviews.append(
            {
                "platform": "shopee",
                "review_id": str(review_id),
                "item_id": str(item.get("itemid") or ""),
                "shop_id": str(item.get("shopid") or ""),
                "rating": int(_number(item.get("rating_star"))),
                "comment": str(item.get("comment") or ""),
                "variant": variant,
                "review_time": timestamp_text(item.get("ctime")),
                "likes": int(_number(item.get("like_count"))),
                "media_count": media_count,
            }
        )
    return reviews


SHEIN_PRODUCT_ID_KEYS = ("goods_id", "goodsId", "product_id", "productId")
SHEIN_PRODUCT_NAME_KEYS = ("goods_name", "goodsName", "product_name", "productName", "title", "name")
SHEIN_PRICE_KEYS = (
    "salePrice", "sale_price", "retailPrice", "retail_price", "unit_price",
    "price", "price_amount", "sale_price_text",
)
SHEIN_SOLD_TEXT_KEYS = (
    "sold_num_text", "soldNumText", "sales_text", "salesText", "sold_text",
    "sale_count_text", "saleCountText", "sales_label", "salesLabel",
    "selling_proposition", "sellingProposition", "selling_point", "sellingPoint",
    "sold_num", "soldNum", "sales_num", "salesNum", "sale_num", "saleNum",
    "sold_count", "soldCount", "sale_count", "saleCount", "total_sales", "totalSales",
    "product_sales", "productSales", "sales_volume", "salesVolume",
)
SHEIN_SOLD_NUMBER_KEYS = (
    "sold_num", "soldNum", "sales_num", "salesNum", "sale_num", "saleNum",
    "sold_count", "soldCount", "sale_count", "saleCount", "total_sales", "totalSales",
    "product_sales", "productSales", "sales_volume", "salesVolume",
)
SHEIN_REVIEW_ID_KEYS = ("comment_id", "commentId", "review_id", "reviewId")


def _walk_dicts(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _walk_dicts(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_dicts(child)


def _first(node: dict[str, Any], keys: Iterable[str], default: Any = None) -> Any:
    for key in keys:
        value = node.get(key)
        if value not in (None, "", [], {}):
            return value
    return default


def _deep_merge(base: dict[str, Any], extra: dict[str, Any]) -> None:
    for key, value in extra.items():
        if key not in base or base[key] in (None, "", [], {}):
            base[key] = value
        elif isinstance(base[key], dict) and isinstance(value, dict):
            _deep_merge(base[key], value)


def _find_shein_sold_value(node: dict[str, Any]) -> Any:
    for key in SHEIN_SOLD_NUMBER_KEYS:
        value = node.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return value
        if isinstance(value, str) and re.fullmatch(r"\s*[0-9]+\s*", value):
            return int(value)

    direct = _first(node, SHEIN_SOLD_TEXT_KEYS)
    if isinstance(direct, str):
        match = re.search(
            r"[0-9][0-9.,]*\s*(?:k|mil|mi|m)?\+?\s*(?:vendid[oa]s?|sold)",
            direct,
            re.IGNORECASE,
        )
        if match:
            return match.group(0)

    def walk_strings(value: Any) -> Iterable[str]:
        if isinstance(value, str):
            yield value
        elif isinstance(value, dict):
            for child in value.values():
                yield from walk_strings(child)
        elif isinstance(value, list):
            for child in value:
                yield from walk_strings(child)

    for text in walk_strings(node):
        match = re.search(
            r"[0-9][0-9.,]*\s*(?:k|mil|mi|m)?\+?\s*(?:vendid[oa]s?|sold)",
            text,
            re.IGNORECASE,
        )
        if match:
            return match.group(0)
    return None


def _localized_number(value: Any, default: float = 0) -> float:
    if value is None or isinstance(value, bool):
        return default
    if isinstance(value, dict):
        value = _first(
            value,
            ("amount", "amountWithSymbol", "amount_with_symbol", "value", "price", "sale_price"),
        )
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).replace("\u00a0", " ")
    match = re.search(r"-?[0-9][0-9.,]*", text)
    if not match:
        return default
    raw = match.group(0)
    if "," in raw and "." in raw:
        if raw.rfind(",") > raw.rfind("."):
            raw = raw.replace(".", "").replace(",", ".")
        else:
            raw = raw.replace(",", "")
    elif "," in raw:
        tail = raw.rsplit(",", 1)[1]
        raw = raw.replace(",", ".") if len(tail) <= 2 else raw.replace(",", "")
    elif "." in raw:
        parts = raw.split(".")
        if len(parts) > 2 or (len(parts) == 2 and len(parts[1]) == 3):
            raw = raw.replace(".", "")
    try:
        return float(raw)
    except ValueError:
        return default


def _absolute_shein_url(value: Any) -> str | None:
    if not value:
        return None
    text = str(value).strip()
    if text.startswith("//"):
        return "https:" + text
    if text.startswith("https://") or text.startswith("http://"):
        return text
    if text.startswith("/"):
        return "https://br.shein.com" + text
    return None


def _shein_price(node: dict[str, Any]) -> float:
    return round(_localized_number(_first(node, SHEIN_PRICE_KEYS)), 2)


def _shein_created_at(node: dict[str, Any]) -> str | None:
    value = _first(
        node,
        ("goods_create_time", "goodsCreateTime", "create_time", "createTime", "on_sale_time", "new_goods_date"),
    )
    return timestamp_text(value)


def _shein_image(node: dict[str, Any]) -> str | None:
    value = _first(
        node,
        ("goods_img", "goodsImg", "image_url", "imageUrl", "product_image", "productImage", "thumbnail"),
    )
    if isinstance(value, dict):
        value = _first(value, ("url", "src", "origin_url", "thumbnail"))
    return _absolute_shein_url(value)


def _shein_product_url(node: dict[str, Any], item_id: str) -> str | None:
    value = _first(node, ("product_url", "productUrl", "goods_url", "goodsUrl", "detail_url", "detailUrl", "url"))
    url = _absolute_shein_url(value)
    if url:
        return url
    slug = _first(node, ("goods_url_name", "goodsUrlName"))
    if slug:
        clean = str(slug).strip().strip("/")
        if clean and " " not in clean:
            if "-p-" not in clean:
                clean = f"{clean}-p-{item_id}.html"
            return "https://br.shein.com/" + clean
    return None


def _shein_product_candidates(payload: dict[str, Any]) -> list[dict[str, Any]]:
    normalized = payload.get("latam_collector")
    if isinstance(normalized, dict) and normalized.get("platform") == "shein":
        data = payload.get("data") or {}
        products = data.get("products") if isinstance(data, dict) else None
        return [item for item in products or [] if isinstance(item, dict)]

    grouped: dict[str, list[tuple[int, dict[str, Any]]]] = {}
    for node in _walk_dicts(payload):
        item_id = _first(node, SHEIN_PRODUCT_ID_KEYS)
        if item_id is None:
            continue
        has_name = _first(node, SHEIN_PRODUCT_NAME_KEYS) is not None
        has_price = _first(node, SHEIN_PRICE_KEYS) is not None
        score = len(node) + (30 if has_name else 0) + (20 if has_price else 0)
        key = str(item_id)
        grouped.setdefault(key, []).append((score, node))

    merged: list[dict[str, Any]] = []
    for entries in grouped.values():
        if not any(_first(node, SHEIN_PRODUCT_NAME_KEYS) is not None or _first(node, SHEIN_PRICE_KEYS) is not None
                   for _, node in entries):
            continue
        result: dict[str, Any] = {}
        for _, node in sorted(entries, key=lambda entry: entry[0], reverse=True):
            _deep_merge(result, node)
        merged.append(result)
    return merged


def parse_shein_products(payload: dict[str, Any]) -> list[dict[str, Any]]:
    products: list[dict[str, Any]] = []
    for node in _shein_product_candidates(payload):
        item_id_value = _first(node, SHEIN_PRODUCT_ID_KEYS)
        if item_id_value is None:
            continue
        item_id = str(item_id_value)
        title = str(_first(node, SHEIN_PRODUCT_NAME_KEYS, "未命名商品"))
        shop_id = str(_first(node, ("mall_code", "mallCode", "mall_id", "store_id", "seller_id"), "shein"))
        sold_value = _find_shein_sold_value(node)
        historical_text = str(sold_value) if sold_value not in (None, "") else None
        historical_raw = sold_value if isinstance(sold_value, (int, float)) and not isinstance(sold_value, bool) else None
        monthly_value = _first(node, ("monthly_sold", "monthlySold", "monthly_sales", "month_sales", "monthly_sold_text"))
        monthly_text = str(monthly_value) if monthly_value not in (None, "") else None
        monthly_raw = monthly_value if isinstance(monthly_value, (int, float)) and not isinstance(monthly_value, bool) else None
        rating = _localized_number(_first(
            node,
            ("comment_rank_average", "commentRankAverage", "goods_score", "rating", "rating_star", "star"),
        ))
        review_count = int(_localized_number(_first(
            node,
            ("comment_num", "commentNum", "review_count", "reviewCount", "comments_count", "rating_count"),
        )))
        category, category_origin = classify_product("shein", title, node)
        image = _shein_image(node)
        product_url = _shein_product_url(node, item_id)
        products.append(
            {
                "platform": "shein",
                "item_id": item_id,
                "shop_id": shop_id,
                "title": title,
                "category": category,
                "category_origin": category_origin,
                "price": _shein_price(node),
                "historical_sold": int(historical_raw) if historical_raw is not None else sold_from_text(historical_text),
                "monthly_sold": int(monthly_raw) if monthly_raw is not None else sold_from_text(monthly_text),
                "historical_sold_text": historical_text,
                "monthly_sold_text": monthly_text,
                "historical_sold_estimated": int(historical_raw is None and bool(historical_text)),
                "monthly_sold_estimated": int(monthly_raw is None and bool(monthly_text)),
                "_historical_available": historical_raw is not None or historical_text is not None,
                "_monthly_available": monthly_raw is not None or monthly_text is not None,
                "rating": round(rating, 3),
                "review_count": review_count,
                "created_at": _shein_created_at(node),
                "shop_name": _first(node, ("mall_name", "mallName", "store_name", "storeName", "brand_name", "brandName")),
                "shop_location": _first(node, ("shop_location", "store_location", "shipping_location")),
                "product_url": product_url,
                "image_url": image,
                "raw_json": json.dumps(node, ensure_ascii=False),
            }
        )
    return products


def _media_count(value: Any) -> int:
    if isinstance(value, list):
        return len(value)
    if isinstance(value, dict):
        return len(value)
    if isinstance(value, str):
        return int(bool(value.strip()))
    return int(_number(value))


def parse_shein_reviews(payload: dict[str, Any]) -> list[dict[str, Any]]:
    reviews: list[dict[str, Any]] = []
    seen: set[str] = set()
    for node in _walk_dicts(payload):
        review_id_value = _first(node, SHEIN_REVIEW_ID_KEYS)
        if review_id_value is None:
            continue
        comment = _first(node, ("comment", "content", "comment_content", "commentContent", "text"))
        rating_value = _first(node, ("comment_rank", "commentRank", "rating", "rating_star", "star", "rank"))
        if comment is None and rating_value is None:
            continue
        review_id = str(review_id_value)
        if review_id in seen:
            continue
        seen.add(review_id)
        images = _first(node, ("comment_images", "commentImages", "images", "image_list"), [])
        videos = _first(node, ("comment_videos", "commentVideos", "videos", "video_list"), [])
        variant = _first(
            node,
            ("goods_style_name", "goodsStyleName", "sku_name", "skuName", "variant", "size", "product_size"),
            "",
        )
        reviews.append(
            {
                "platform": "shein",
                "review_id": review_id,
                "item_id": str(_first(node, SHEIN_PRODUCT_ID_KEYS, "")),
                "shop_id": str(_first(node, ("mall_code", "mallCode", "mall_id", "store_id", "seller_id"), "shein")),
                "rating": int(_localized_number(rating_value)),
                "comment": str(comment or ""),
                "variant": str(variant or ""),
                "review_time": timestamp_text(_first(
                    node,
                    ("comment_time", "commentTime", "create_time", "createTime", "add_time", "addTime", "date"),
                )),
                "likes": int(_localized_number(_first(node, ("like_num", "likeNum", "like_count", "likes")))),
                "media_count": _media_count(images) + _media_count(videos),
            }
        )
    return reviews


def detect_platform(payload: dict[str, Any]) -> str:
    metadata = payload.get("latam_collector")
    if isinstance(metadata, dict) and metadata.get("platform") == "shein":
        return "shein"
    for index, node in enumerate(_walk_dicts(payload)):
        if any(key in node for key in SHEIN_PRODUCT_ID_KEYS + SHEIN_REVIEW_ID_KEYS):
            return "shein"
        if index >= 2000:
            break
    return "shopee"


def parse_products(payload: dict[str, Any], platform: str | None = None) -> list[dict[str, Any]]:
    resolved = platform or detect_platform(payload)
    if resolved == "shein":
        return parse_shein_products(payload)
    return parse_shopee_products(payload)


def parse_reviews(payload: dict[str, Any], platform: str | None = None) -> list[dict[str, Any]]:
    resolved = platform or detect_platform(payload)
    if resolved == "shein":
        return parse_shein_reviews(payload)
    return parse_shopee_reviews(payload)

