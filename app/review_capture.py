from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qs, urlsplit

REVIEW_PATHS = {
    "shopee": ("/get_ratings",),
    "shein": (
        "/api/comment/abccommentinfo/query",
        "/api/comment/abccommentimages/query",
        "/product/get_goods_review_detail",
        "/product/get_goods_comment_offset",
    ),
}


@dataclass(frozen=True)
class ReviewTarget:
    platform: str
    shop_id: str
    item_id: str
    verified_request: bool

    def attach(self, review: dict[str, Any]) -> bool:
        """Use known request identifiers only when they match the open product."""
        item_id = review["item_id"]
        shop_id = review["shop_id"]
        if item_id != self.item_id and (item_id or not self.verified_request):
            return False
        generic_shop = not shop_id or (self.platform == "shein" and shop_id == "shein")
        if shop_id != self.shop_id and not generic_shop:
            return False
        # Shopee's shop identity is required in either the row or request.
        if self.platform == "shopee" and generic_shop and not self.verified_request:
            return False
        review["item_id"] = self.item_id
        review["shop_id"] = self.shop_id
        return True


def _public_url(value: str):
    try:
        url = urlsplit(value)
        if url.scheme != "https" or url.username or url.password or url.port is not None:
            return None
        return url
    except ValueError:
        return None


def _platform(host: str | None) -> str:
    if host in ("shopee.com.br", "www.shopee.com.br"):
        return "shopee"
    if host in ("br.shein.com", "www.br.shein.com"):
        return "shein"
    return ""


def _identifier(query: dict[str, list[str]], names: tuple[str, ...]) -> str:
    values = [value for name in names for value in query.get(name, [])]
    if not values:
        return ""
    return values[0] if len(set(values)) == 1 and re.fullmatch(r"\d+", values[0]) else "invalid"


def review_target(db: sqlite3.Connection, source_url: str, page_url: str, payload: dict[str, Any]) -> ReviewTarget | None:
    page, source = _public_url(page_url), _public_url(source_url)
    if page is None or source is None:
        return None
    platform = _platform(page.hostname)
    if not platform or platform != _platform(source.hostname):
        return None
    if not source.path.lower().rstrip("/").endswith(REVIEW_PATHS[platform]):
        return None

    query = parse_qs(source.query, keep_blank_values=True)
    if platform == "shopee":
        path = page.path.rstrip("/")
        match = re.fullmatch(r"/product/(\d+)/(\d+)", path, re.I) or re.search(r"-i\.(\d+)\.(\d+)$", path, re.I)
        if not match:
            return None
        shop_id, item_id = match.groups()
        request_shop = _identifier(query, ("shopid", "shop_id"))
        request_item = _identifier(query, ("itemid", "item_id"))
        if (request_shop and request_shop != shop_id) or (request_item and request_item != item_id):
            return None
        return ReviewTarget(platform, shop_id, item_id, bool(request_shop and request_item))

    match = re.search(r"-p-(\d+)\.html/?$", page.path, re.I)
    if not match:
        return None
    item_id = match[1]
    request_item = _identifier(query, ("goods_id", "goodsId", "product_id", "productId"))
    data = payload.get("data")
    if isinstance(data, dict) and not request_item:
        request_item = str(data.get("goods_id") or data.get("goodsId") or "")
    if request_item and request_item != item_id:
        return None
    shops = db.execute(
        "SELECT shop_id FROM products WHERE platform='shein' AND item_id=? LIMIT 2", (item_id,),
    ).fetchall()
    if len(shops) != 1:
        return None
    return ReviewTarget(platform, shops[0]["shop_id"], item_id, request_item == item_id)


def reconcile_review_identity(review: dict[str, Any], previous: sqlite3.Row | None) -> bool:
    if previous is None:
        return True
    for field in ("item_id", "shop_id"):
        old, new = previous[field], review[field]
        placeholder = "shein" if field == "shop_id" and review["platform"] == "shein" else ""
        if old and old != placeholder and new and new != placeholder and old != new:
            return False
        if not new or new == placeholder:
            review[field] = old
    return True
