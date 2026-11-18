from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable


HARDWARE_WORDS = (
    "ferrament", "furadeira", "parafusadeira", "chave", "broca", "soquete",
    "alicate", "martelo", "serra", "compressor", "solda", "bateria 21v",
)
FASHION_WORDS = (
    "vestido", "blusa", "camisa", "calça", "saia", "short feminino",
    "conjunto feminino", "moda feminina", "cropped", "legging",
)
HOME_WORDS = (
    "cozinha", "casa", "limpeza", "organizador", "marmita", "frigideira",
    "decoração", "banheiro", "cama", "toalha", "escova", "pote",
)
ELECTRONICS_WORDS = (
    "fone", "carregador", "smartwatch", "cabo usb", "caixa de som",
    "eletrônico", "camera", "câmera", "lâmpada led", "lampada led",
)
BEAUTY_WORDS = (
    "maquiagem", "beleza", "skincare", "cabelo", "unha", "perfume",
    "hidratante", "escova secadora",
)
SPORT_WORDS = (
    "academia", "fitness", "esporte", "bicicleta", "camping", "corrida",
    "halter", "yoga",
)
KIDS_WORDS = ("bebê", "bebe", "infantil", "brinquedo", "criança", "crianca")


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
    try:
        brazil_time = timezone(timedelta(hours=-3))
        return datetime.fromtimestamp(int(value), tz=brazil_time).isoformat()
    except (TypeError, ValueError, OSError):
        return None


def infer_category(title: str, categories: Any = None) -> str:
    lowered = title.casefold()
    if any(word in lowered for word in HARDWARE_WORDS):
        return "五金工具"
    if any(word in lowered for word in FASHION_WORDS):
        return "女装服装"
    if any(word in lowered for word in HOME_WORDS):
        return "家居百货"
    if any(word in lowered for word in ELECTRONICS_WORDS):
        return "数码家电"
    if any(word in lowered for word in BEAUTY_WORDS):
        return "美妆个护"
    if any(word in lowered for word in SPORT_WORDS):
        return "运动户外"
    if any(word in lowered for word in KIDS_WORDS):
        return "母婴玩具"
    return "未分类"


def image_url(image_id: Any) -> str | None:
    if not image_id:
        return None
    return "https://down-br.img.susercontent.com/file/" + str(image_id)


def iter_product_nodes(payload: dict[str, Any]) -> Iterable[dict[str, Any]]:
    data = payload.get("data")
    if isinstance(data, dict) and isinstance(data.get("units"), list):
        for unit in data["units"]:
            if isinstance(unit, dict) and isinstance(unit.get("item"), dict):
                yield unit["item"]
    if isinstance(data, dict) and isinstance(data.get("item"), dict):
        yield data["item"]
    if isinstance(data, dict) and (data.get("itemid") is not None or data.get("item_id") is not None):
        yield data
    if isinstance(payload.get("item"), dict):
        yield payload["item"]
    if isinstance(payload.get("items"), list):
        for item in payload["items"]:
            if isinstance(item, dict):
                yield item


def parse_products(payload: dict[str, Any]) -> list[dict[str, Any]]:
    products: list[dict[str, Any]] = []
    for node in iter_product_nodes(payload):
        data = node.get("item_data") or node
        asset = node.get("item_card_displayed_asset") or {}
        item_id = data.get("itemid") or data.get("item_id") or node.get("itemid")
        shop_id = data.get("shopid") or data.get("shop_id") or node.get("shopid")
        if item_id is None or shop_id is None:
            continue
        price_info = data.get("item_card_display_price") or {}
        sold_info = data.get("item_card_display_sold_count") or {}
        rating_info = data.get("item_rating") or {}
        shop_info = data.get("shop_data") or {}
        title = str(asset.get("name") or data.get("name") or node.get("display_name") or "未命名商品")
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
                "category": infer_category(title, data.get("global_cat")),
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
                "image_url": image_url(asset.get("image") or data.get("image")),
                "raw_json": json.dumps(node, ensure_ascii=False),
            }
        )
    return products


def parse_reviews(payload: dict[str, Any]) -> list[dict[str, Any]]:
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

