from __future__ import annotations

import csv
import io
import json
import math
import os
import shutil
import sqlite3
import socket
import sys
import threading
import time
import webbrowser
from datetime import datetime, timezone
from http.client import HTTPConnection, HTTPException as HTTPClientError
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse
from openpyxl import Workbook

from .categories import CATEGORY_GROUPS, CATEGORY_ORIGIN_RANK, CATEGORIES, classify_stored_product
from .database import DB_PATH, add_log, connect, initialize, normalize_existing_categories
from .parser import detect_platform, parse_products, parse_reviews


PLATFORM_HOST = "127.0.0.1"
PLATFORM_PORT = 8765
PLATFORM_URL = f"http://{PLATFORM_HOST}:{PLATFORM_PORT}"


def resource_path(relative: str) -> Path:
    root = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1]))
    return root / relative


def ensure_extension_files() -> None:
    """Expose bundled Chrome extension files next to a frozen EXE."""
    source = resource_path("chrome_extension")
    if not source.exists():
        return
    if getattr(sys, "frozen", False):
        target = Path(sys.executable).resolve().parent / "chrome_extension"
        bundled_version = extension_version(source)
        installed_version = extension_version(target)
        if installed_version > bundled_version:
            return
        if installed_version == bundled_version and all(
            (target / file.relative_to(source)).is_file() for file in source.rglob("*") if file.is_file()
        ):
            return
        shutil.copytree(source, target, dirs_exist_ok=True)


def extension_version(folder: Path) -> tuple[int, ...]:
    try:
        manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
        return tuple(int(part) for part in manifest["version"].split("."))
    except (AttributeError, KeyError, OSError, TypeError, ValueError):
        return ()


def backfill_shopee_images() -> int:
    """Recover thumbnails from stored raw JSON without deleting or reimporting user data."""
    updated = 0
    with connect() as db:
        rows = db.execute(
            """SELECT id, raw_json FROM products
               WHERE platform='shopee' AND (image_url IS NULL OR image_url='')
                 AND raw_json IS NOT NULL AND raw_json<>''"""
        ).fetchall()
        for row in rows:
            try:
                raw = json.loads(row["raw_json"])
                parsed = parse_products({"items": [raw]}, "shopee")
                thumbnail = parsed[0].get("image_url") if parsed else None
            except (json.JSONDecodeError, TypeError, ValueError):
                thumbnail = None
            if thumbnail:
                db.execute("UPDATE products SET image_url=? WHERE id=?", (thumbnail, row["id"]))
                updated += 1
    return updated


app = FastAPI(title="LatAm Collector", docs_url=None, redoc_url=None)


@app.on_event("startup")
def startup() -> None:
    initialize()
    normalize_existing_categories()
    recovered = backfill_shopee_images()
    if recovered:
        add_log("Shopee 图片", f"已从历史原始数据补回 {recovered} 张商品图片")
    ensure_extension_files()


@app.get("/", response_class=HTMLResponse)
def home():
    return FileResponse(resource_path("static/index.html"))


@app.get("/api/stats")
def stats():
    with connect() as db:
        product_count = db.execute("SELECT COUNT(*) FROM products").fetchone()[0]
        review_count = db.execute(
            """SELECT COUNT(*) FROM reviews
               WHERE CAST(substr(review_time,1,4) AS INTEGER) BETWEEN 2025 AND 2026"""
        ).fetchone()[0]
        qualified = db.execute(
            """SELECT COUNT(*) FROM products
               WHERE price >= 32 AND monthly_sold >= 1000
                 AND substr(created_at, 1, 4) IN ('2024','2025','2026')"""
        ).fetchone()[0]
        task_count = db.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]
        favorites = db.execute("SELECT COUNT(*) FROM products WHERE is_favorite=1").fetchone()[0]
        captures = db.execute("SELECT COUNT(*) FROM capture_events").fetchone()[0]
        last_capture = db.execute("SELECT captured_at FROM capture_events ORDER BY id DESC LIMIT 1").fetchone()
    return {
        "products": product_count,
        "reviews": review_count,
        "qualified": qualified,
        "tasks": task_count,
        "favorites": favorites,
        "captures": captures,
        "last_capture": last_capture[0] if last_capture else None,
    }


def product_query(params: dict[str, Any]) -> tuple[str, list[Any]]:
    where = ["1=1"]
    values: list[Any] = []
    mapping = {
        "platform": "platform = ?",
        "category": "category = ?",
    }
    for key, clause in mapping.items():
        if params.get(key):
            where.append(clause)
            values.append(params[key])
    raw_years = str(params.get("years") or params.get("year") or "")
    years = [value.strip() for value in raw_years.split(",")
             if len(value.strip()) == 4 and value.strip().isdigit()]
    if years:
        where.append("(substr(created_at, 1, 4) IN (" + ",".join("?" for _ in years) + ") OR created_at IS NULL OR created_at='')")
        values.extend(years)
    if params.get("min_price") not in (None, ""):
        where.append("price >= ?")
        values.append(float(params["min_price"]))
    if params.get("max_price") not in (None, ""):
        where.append("price <= ?")
        values.append(float(params["max_price"]))
    sales_metric = str(params.get("sales_metric") or "monthly")
    sales_column = "historical_sold" if sales_metric == "historical" else "monthly_sold"
    if params.get("min_sales") not in (None, ""):
        where.append(f"{sales_column} >= ?")
        values.append(int(params["min_sales"]))
    if params.get("max_sales") not in (None, ""):
        where.append(f"{sales_column} <= ?")
        values.append(int(params["max_sales"]))
    if params.get("min_rating") not in (None, ""):
        where.append("rating >= ?")
        values.append(float(params["min_rating"]))
    if params.get("min_reviews") not in (None, ""):
        where.append("review_count >= ?")
        values.append(int(params["min_reviews"]))
    if params.get("min_growth") not in (None, ""):
        growth_column = "historical_sold_delta" if sales_metric == "historical" else "monthly_sold_delta"
        where.append(f"{growth_column} >= ?")
        values.append(int(params["min_growth"]))
    quality = str(params.get("sales_quality") or "")
    quality_column = "historical_sold_estimated" if sales_metric == "historical" else "monthly_sold_estimated"
    if quality == "exact":
        where.append(f"{quality_column} = 0 AND {sales_column} > 0")
    elif quality == "estimated":
        where.append(f"{quality_column} = 1")
    if str(params.get("favorite") or "") == "1":
        where.append("is_favorite = 1")
    image_state = str(params.get("image_state") or "")
    if image_state == "with":
        where.append("image_url IS NOT NULL AND image_url <> ''")
    elif image_state == "missing":
        where.append("(image_url IS NULL OR image_url = '')")
    if params.get("location"):
        where.append("shop_location LIKE ?")
        values.append("%" + str(params["location"]) + "%")
    if params.get("q"):
        where.append("(title LIKE ? OR shop_name LIKE ?)")
        term = "%" + str(params["q"]) + "%"
        values.extend([term, term])
    return " AND ".join(where), values


def category_counts(db: sqlite3.Connection, where: str, values: list[Any]) -> dict[str, int]:
    rows = db.execute(f"SELECT category, COUNT(*) FROM products WHERE {where} GROUP BY category", values)
    return {category: count for category, count in rows if category in CATEGORIES}


def product_age_days(created_at: Any) -> int | None:
    if not created_at:
        return None
    try:
        created = datetime.fromisoformat(str(created_at).replace("Z", "+00:00"))
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        return max(0, (datetime.now(timezone.utc) - created.astimezone(timezone.utc)).days)
    except (TypeError, ValueError):
        return None


def enrich_product(item: dict[str, Any]) -> dict[str, Any]:
    monthly = max(0, int(item.get("monthly_sold") or 0))
    historical = max(0, int(item.get("historical_sold") or 0))
    rating = max(0.0, float(item.get("rating") or 0))
    age_days = product_age_days(item.get("created_at"))
    demand = min(35.0, math.log10(monthly + 1) * 11.66)
    proof = min(15.0, math.log10(historical + 1) * 3.0)
    rating_score = min(20.0, max(0.0, (rating - 3.0) * 10.0))
    if age_days is None:
        recency = 0.0
    elif age_days <= 365:
        recency = 20.0
    elif age_days <= 730:
        recency = 12.0
    else:
        recency = 6.0
    price = float(item.get("price") or 0)
    price_fit = 10.0 if 32 <= price <= 300 else 5.0 if price > 0 else 0.0
    item["opportunity_score"] = round(min(100.0, demand + proof + rating_score + recency + price_fit), 1)
    item["age_days"] = age_days
    if monthly >= 1000 and age_days is not None and age_days <= 730:
        item["lifecycle"] = "新品爆发"
    elif monthly >= 1000:
        item["lifecycle"] = "稳定热卖"
    elif historical >= 1000 and monthly < 100:
        item["lifecycle"] = "热度回落"
    else:
        item["lifecycle"] = "继续观察"
    item["historical_sold_quality"] = "估算" if item.get("historical_sold_estimated") else ("精确" if historical else "未知")
    item["monthly_sold_quality"] = "估算" if item.get("monthly_sold_estimated") else ("精确" if monthly else "未知")
    return item


@app.get("/api/products")
def products(
    platform: str = "",
    category: str = "",
    year: str = "",
    years: str = "",
    min_price: str = "",
    max_price: str = "",
    sales_metric: str = "monthly",
    min_sales: str = "",
    max_sales: str = "",
    min_growth: str = "",
    min_rating: str = "",
    min_reviews: str = "",
    sales_quality: str = "",
    favorite: str = "",
    image_state: str = "",
    location: str = "",
    q: str = "",
    sort_by: str = "monthly_sold",
    sort_dir: str = "desc",
    page: int = 1,
    page_size: int = 50,
):
    page = max(page, 1)
    page_size = min(max(page_size, 1), 200)
    where, values = product_query(locals())
    facet_where, facet_values = product_query({**locals(), "category": ""})
    sort_columns = {
        "historical_sold": "historical_sold",
        "monthly_sold": "monthly_sold",
        "growth": "monthly_sold_delta" if sales_metric != "historical" else "historical_sold_delta",
        "price": "price",
        "rating": "rating",
        "reviews": "review_count",
        "newest": "created_at",
        "updated": "imported_at",
    }
    direction = "ASC" if sort_dir.lower() == "asc" else "DESC"
    with connect() as db:
        db.execute("BEGIN")
        counts = category_counts(db, facet_where, facet_values)
        total = db.execute("SELECT COUNT(*) FROM products WHERE " + where, values).fetchone()[0]
        page = min(page, max(1, (total + page_size - 1) // page_size))
        if sort_by == "opportunity":
            all_rows = [enrich_product(dict(row)) for row in db.execute("SELECT * FROM products WHERE " + where, values).fetchall()]
            all_rows.sort(key=lambda row: (row["opportunity_score"], row["monthly_sold"], row["id"]), reverse=direction == "DESC")
            items = all_rows[(page - 1) * page_size:page * page_size]
        else:
            order_column = sort_columns.get(sort_by, "monthly_sold")
            rows = db.execute(
                f"SELECT * FROM products WHERE {where} ORDER BY {order_column} {direction}, id DESC LIMIT ? OFFSET ?",
                values + [page_size, (page - 1) * page_size],
            ).fetchall()
            items = [enrich_product(dict(row)) for row in rows]
    return {
        "total": total, "page": page, "page_size": page_size, "items": items,
        "category_groups": CATEGORY_GROUPS, "category_counts": counts,
    }


@app.get("/api/product-options")
def product_options(platform: str = ""):
    where, values = product_query({"platform": platform})
    with connect() as db:
        counts = category_counts(db, where, values)
        locations = [row[0] for row in db.execute(
            f"""SELECT DISTINCT shop_location FROM products
                WHERE {where} AND shop_location IS NOT NULL AND shop_location<>''
                ORDER BY shop_location LIMIT 100""", values,
        )]
        platforms = [row[0] for row in db.execute("SELECT DISTINCT platform FROM products ORDER BY platform").fetchall()]
    return {
        "categories": [category for category in CATEGORIES if category in counts],
        "category_groups": CATEGORY_GROUPS, "category_counts": counts,
        "locations": locations, "platforms": platforms,
    }


@app.patch("/api/products/{product_id}")
async def update_product(product_id: int, request: Request):
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(400, "商品更新必须是 JSON 对象")
    updates: list[str] = []
    values: list[Any] = []
    if "is_favorite" in body:
        updates.append("is_favorite=?")
        values.append(1 if body["is_favorite"] else 0)
    if "note" in body:
        updates.append("note=?")
        values.append(str(body["note"])[:2000])
    if not updates and "category" not in body:
        raise HTTPException(400, "没有可更新的内容")
    with connect() as db:
        if "category" in body:
            chosen_category = body["category"]
            if chosen_category is None:
                db.execute("BEGIN IMMEDIATE")
                row = db.execute(
                    "SELECT platform, title, raw_json FROM products WHERE id=?", (product_id,),
                ).fetchone()
                if row is None:
                    raise HTTPException(404, "商品不存在")
                chosen_category, origin = classify_stored_product(row)
            elif isinstance(chosen_category, str) and chosen_category in CATEGORIES:
                origin = "manual"
            else:
                raise HTTPException(400, "请选择品类列表中的选项")
            updates.extend(("category=?", "category_origin=?"))
            values.extend((chosen_category, origin))
        values.append(product_id)
        cur = db.execute("UPDATE products SET " + ",".join(updates) + " WHERE id=?", values)
        if cur.rowcount == 0:
            raise HTTPException(404, "商品不存在")
    return {"ok": True}


REVIEW_TOPICS = {
    "物流时效": ("entrega", "chegou", "prazo", "demor", "rápido", "rapido"),
    "质量做工": ("qualidade", "material", "resistente", "durável", "duravel", "quebrou", "defeito"),
    "包装破损": ("embalagem", "amassado", "quebrado", "danificado", "avariado"),
    "尺寸规格": ("tamanho", "pequeno", "grande", "medida", "serviu", "apertado"),
    "性价比": ("preço", "preco", "custo", "vale a pena", "barato", "caro"),
    "商品一致": ("igual", "foto", "descrição", "descricao", "diferente", "anúncio", "anuncio"),
}


def review_sentiment(rating: int) -> str:
    if rating >= 4:
        return "正向"
    if rating == 3:
        return "中性"
    return "负向"


def review_topics(comment: Any) -> list[str]:
    lowered = str(comment or "").casefold()
    return [name for name, words in REVIEW_TOPICS.items() if any(word in lowered for word in words)]


def enrich_review(item: dict[str, Any]) -> dict[str, Any]:
    item["sentiment"] = review_sentiment(int(item.get("rating") or 0))
    item["topics"] = review_topics(item.get("comment"))
    return item


@app.get("/api/reviews")
def reviews(
    platform: str = "",
    year_from: int = 2025,
    year_to: int = 2026,
    min_rating: int = 0,
    max_rating: int = 5,
    q: str = "",
    item_id: str = "",
    has_media: str = "",
    sentiment: str = "",
    topic: str = "",
    page: int = 1,
    page_size: int = 50,
):
    page_size = min(max(page_size, 1), 200)
    page = max(page, 1)
    where = ["CAST(substr(r.review_time,1,4) AS INTEGER) BETWEEN ? AND ?", "r.rating BETWEEN ? AND ?"]
    values: list[Any] = [year_from, year_to, min_rating, max_rating]
    if platform:
        where.append("r.platform = ?")
        values.append(platform)
    if q:
        where.append("r.comment LIKE ?")
        values.append("%" + q + "%")
    if item_id:
        where.append("r.item_id = ?")
        values.append(item_id)
    if has_media == "1":
        where.append("r.media_count > 0")
    elif has_media == "0":
        where.append("r.media_count = 0")
    if sentiment == "positive":
        where.append("r.rating >= 4")
    elif sentiment == "neutral":
        where.append("r.rating = 3")
    elif sentiment == "negative":
        where.append("r.rating <= 2")
    if topic in REVIEW_TOPICS:
        topic_parts = []
        for word in REVIEW_TOPICS[topic]:
            topic_parts.append("LOWER(r.comment) LIKE ?")
            values.append("%" + word + "%")
        where.append("(" + " OR ".join(topic_parts) + ")")
    clause = " AND ".join(where)
    with connect() as db:
        total = db.execute("SELECT COUNT(*) FROM reviews r WHERE " + clause, values).fetchone()[0]
        rows = db.execute(
            """SELECT r.*, p.title FROM reviews r
               LEFT JOIN products p ON p.platform=r.platform AND p.item_id=r.item_id AND p.shop_id=r.shop_id
               WHERE """ + clause + " ORDER BY r.review_time DESC LIMIT ? OFFSET ?",
            values + [page_size, (page - 1) * page_size],
        ).fetchall()
    return {"total": total, "page": page, "page_size": page_size, "items": [enrich_review(dict(row)) for row in rows]}


@app.get("/api/review-insights")
def review_insights(year_from: int = 2025, year_to: int = 2026, platform: str = ""):
    where = "CAST(substr(review_time,1,4) AS INTEGER) BETWEEN ? AND ?"
    values: list[Any] = [year_from, year_to]
    if platform:
        where += " AND platform = ?"
        values.append(platform)
    with connect() as db:
        rows = db.execute(
            """SELECT rating, comment, media_count FROM reviews
               WHERE """ + where,
            values,
        ).fetchall()
    sentiments = {"正向": 0, "中性": 0, "负向": 0}
    stars = {str(i): 0 for i in range(1, 6)}
    topics = {name: 0 for name in REVIEW_TOPICS}
    with_text = media = 0
    for row in rows:
        rating = int(row["rating"] or 0)
        sentiments[review_sentiment(rating)] += 1
        if 1 <= rating <= 5:
            stars[str(rating)] += 1
        comment = row["comment"] or ""
        if comment.strip():
            with_text += 1
        if int(row["media_count"] or 0) > 0:
            media += 1
        for topic_name in review_topics(comment):
            topics[topic_name] += 1
    return {
        "total": len(rows),
        "with_text": with_text,
        "with_media": media,
        "sentiments": sentiments,
        "stars": stars,
        "topics": topics,
        "note": "情绪按星级计算；主题按葡萄牙语关键词归类。",
    }


def import_payload(payload: dict[str, Any], source: str = "数据导入", source_url: str = "") -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise HTTPException(400, "JSON 顶层必须是对象")
    host = (urlparse(source_url).hostname or "").lower() if source_url else ""
    if host == "br.shein.com" or host.endswith(".br.shein.com"):
        platform = "shein"
    elif host == "shopee.com.br" or host.endswith(".shopee.com.br"):
        platform = "shopee"
    else:
        platform = detect_platform(payload)
    products_found = parse_products(payload, platform)
    reviews_found = parse_reviews(payload, platform)
    new_products = updated_products = new_reviews = updated_reviews = 0
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        for p in products_found:
            existing = db.execute(
                "SELECT * FROM products WHERE platform=? AND shop_id=? AND item_id=?",
                (p["platform"], p["shop_id"], p["item_id"]),
            ).fetchone()
            if existing:
                existing = dict(existing)
                if CATEGORY_ORIGIN_RANK.get(existing["category_origin"], 0) > CATEGORY_ORIGIN_RANK[p["category_origin"]]:
                    p["category"] = existing["category"]
                    p["category_origin"] = existing["category_origin"]
                if not p.pop("_historical_available", False):
                    p["historical_sold"] = existing["historical_sold"]
                    p["historical_sold_text"] = existing["historical_sold_text"]
                    p["historical_sold_estimated"] = existing["historical_sold_estimated"]
                if not p.pop("_monthly_available", False):
                    p["monthly_sold"] = existing["monthly_sold"]
                    p["monthly_sold_text"] = existing["monthly_sold_text"]
                    p["monthly_sold_estimated"] = existing["monthly_sold_estimated"]
                if not p["price"]:
                    p["price"] = existing["price"]
                if not p["created_at"]:
                    p["created_at"] = existing["created_at"]
                if p["title"] == "未命名商品":
                    p["title"] = existing["title"]
                for nullable in ("shop_name", "shop_location", "product_url", "image_url"):
                    if not p.get(nullable):
                        p[nullable] = existing[nullable]
                p["historical_sold_delta"] = int(p["historical_sold"] or 0) - int(existing["historical_sold"] or 0)
                p["monthly_sold_delta"] = int(p["monthly_sold"] or 0) - int(existing["monthly_sold"] or 0)
                p["price_delta"] = round(float(p["price"] or 0) - float(existing["price"] or 0), 2)
                p["capture_count"] = int(existing["capture_count"] or 0) + 1
                changed = any((p["historical_sold_delta"], p["monthly_sold_delta"], p["price_delta"]))
                p["last_changed_at"] = datetime.now(timezone.utc).isoformat() if changed else existing["last_changed_at"]
                updated_products += 1
            else:
                p.pop("_historical_available", None)
                p.pop("_monthly_available", None)
                p.update({
                    "historical_sold_delta": 0,
                    "monthly_sold_delta": 0,
                    "price_delta": 0,
                    "capture_count": 1,
                    "last_changed_at": None,
                })
                new_products += 1
            db.execute(
                """INSERT INTO products(
                    platform,item_id,shop_id,title,category,category_origin,price,historical_sold,monthly_sold,
                    historical_sold_text,monthly_sold_text,historical_sold_estimated,monthly_sold_estimated,
                    historical_sold_delta,monthly_sold_delta,price_delta,rating,review_count,created_at,
                    shop_name,shop_location,product_url,image_url,raw_json,capture_count,last_changed_at
                ) VALUES (
                    :platform,:item_id,:shop_id,:title,:category,:category_origin,:price,:historical_sold,:monthly_sold,
                    :historical_sold_text,:monthly_sold_text,:historical_sold_estimated,:monthly_sold_estimated,
                    :historical_sold_delta,:monthly_sold_delta,:price_delta,:rating,:review_count,:created_at,
                    :shop_name,:shop_location,:product_url,:image_url,:raw_json,:capture_count,:last_changed_at
                ) ON CONFLICT(platform,shop_id,item_id) DO UPDATE SET
                    title=excluded.title, category=excluded.category,
                    category_origin=excluded.category_origin, price=excluded.price,
                    historical_sold=excluded.historical_sold, monthly_sold=excluded.monthly_sold,
                    historical_sold_text=excluded.historical_sold_text,
                    monthly_sold_text=excluded.monthly_sold_text,
                    historical_sold_estimated=excluded.historical_sold_estimated,
                    monthly_sold_estimated=excluded.monthly_sold_estimated,
                    historical_sold_delta=excluded.historical_sold_delta,
                    monthly_sold_delta=excluded.monthly_sold_delta, price_delta=excluded.price_delta,
                    capture_count=excluded.capture_count, last_changed_at=excluded.last_changed_at,
                    rating=excluded.rating,
                    review_count=excluded.review_count, created_at=excluded.created_at,
                    shop_name=excluded.shop_name, shop_location=excluded.shop_location,
                    product_url=excluded.product_url, image_url=excluded.image_url,
                    raw_json=excluded.raw_json, imported_at=CURRENT_TIMESTAMP""",
                p,
            )
        for r in reviews_found:
            exists = db.execute(
                "SELECT 1 FROM reviews WHERE platform=? AND review_id=?",
                (r["platform"], r["review_id"]),
            ).fetchone()
            if exists:
                updated_reviews += 1
            else:
                new_reviews += 1
            db.execute(
                """INSERT INTO reviews(platform,review_id,item_id,shop_id,rating,comment,variant,review_time,likes,media_count)
                   VALUES (:platform,:review_id,:item_id,:shop_id,:rating,:comment,:variant,:review_time,:likes,:media_count)
                   ON CONFLICT(platform,review_id) DO UPDATE SET
                   rating=excluded.rating,comment=excluded.comment,variant=excluded.variant,
                   review_time=excluded.review_time,likes=excluded.likes,media_count=excluded.media_count""",
                r,
            )
        lowered_source_url = source_url.lower()
        comment_markers = ("get_ratings", "/comment/", "goods_review", "goods_comment")
        detail_markers = ("item/get", "pdp/get_pc", "productdetail", "quickview", "detail_static", "detail_realtime")
        source_type = f"{platform.upper()} 评论" if any(marker in lowered_source_url for marker in comment_markers) else (
            f"{platform.upper()} 商品详情" if any(marker in lowered_source_url for marker in detail_markers) else f"{platform.upper()} 商品列表"
        )
        db.execute(
            """INSERT INTO capture_events(
                   source_type,source_url,product_count,review_count,new_product_count,new_review_count
               ) VALUES(?,?,?,?,?,?)""",
            (source_type if source_url else source, source_url, len(products_found), len(reviews_found), new_products, new_reviews),
        )
    message = (
        f"识别商品 {len(products_found)} 条（新增 {new_products}、更新 {updated_products}），"
        f"评论 {len(reviews_found)} 条（新增 {new_reviews}、更新 {updated_reviews}）"
    )
    add_log(source, message)
    return {
        "ok": True,
        "message": message,
        "products": len(products_found),
        "reviews": len(reviews_found),
        "new_products": new_products,
        "updated_products": updated_products,
        "new_reviews": new_reviews,
        "updated_reviews": updated_reviews,
    }


@app.post("/api/import/json")
async def import_json(request: Request):
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(400, "文件不是有效的 JSON") from exc
    return import_payload(payload)


CAPTURE_URL_MARKERS = {
    "shopee": ("search_items", "recommend_v2", "get_ratings", "item/get", "pdp/get_pc"),
    "shein": (
        "/api/productlist/info/get", "/api/productinfo/productdetail/get",
        "/api/productinfo/quickview/get", "/api/comment/abccommentinfo/query",
        "/api/comment/abccommentimages/query", "/api/comment/abccommentsummary/get",
        "/product/get_goods_review_detail", "/product/get_goods_comment_offset",
        "/category/real_category_goods_list", "/product/get_products_by_keywords",
        "/product/get_goods_detail_static_data", "/product/get_goods_detail_realtime_data",
        "/api/productlist/firstgold/get", "/category/get_select_product_list",
        "/category/get_tags_goods_list", "/category/category_daily_new",
        "/category/get_products_by_discount_list", "/product/search/getpregoodscomponent",
        "/product/search/getsearchcontentcarrier", "/search/card/non_category_by_keyword",
        "/search/card/non_category_by_keywords", "/navigation-api/store/new-arrivals",
        "/store-api/store/category/products", "/api/ccc/store/product/query",
        "/__latam_collector_dom__/",
    ),
}


@app.post("/api/capture")
async def capture_from_chrome(request: Request):
    try:
        body = await request.json()
    except Exception as exc:
        raise HTTPException(400, "无效的采集数据") from exc
    source_url = str(body.get("source_url") or "")
    payload = body.get("payload")
    parsed_url = urlparse(source_url)
    host = (parsed_url.hostname or "").lower()
    platform = ""
    if host == "shopee.com.br" or host.endswith(".shopee.com.br"):
        platform = "shopee"
    elif host == "br.shein.com" or host.endswith(".br.shein.com"):
        platform = "shein"
    if parsed_url.scheme != "https" or not platform:
        raise HTTPException(403, "只接受 Shopee 或 SHEIN 巴西站公开数据")
    lowered_source_url = source_url.lower()
    if not any(marker in lowered_source_url for marker in CAPTURE_URL_MARKERS[platform]):
        raise HTTPException(400, "不是已支持的数据接口")
    if not isinstance(payload, dict):
        raise HTTPException(400, "响应内容不是 JSON 对象")
    result = import_payload(payload, f"Chrome采集助手/{platform}", source_url)
    result["platform"] = platform
    result["source_url"] = source_url
    return result


@app.get("/api/capture-status")
def capture_status():
    with connect() as db:
        last = db.execute("SELECT * FROM capture_events ORDER BY id DESC LIMIT 1").fetchone()
        totals = db.execute(
            """SELECT COUNT(*) events, COALESCE(SUM(product_count),0) products,
                      COALESCE(SUM(review_count),0) reviews
               FROM capture_events"""
        ).fetchone()
    return {"last": dict(last) if last else None, "totals": dict(totals)}


@app.get("/api/analytics")
def analytics():
    with connect() as db:
        categories = [dict(row) for row in db.execute(
            """SELECT category, COUNT(*) product_count,
                      ROUND(AVG(price),2) avg_price,
                      SUM(monthly_sold) monthly_sales
               FROM products GROUP BY category ORDER BY monthly_sales DESC"""
        ).fetchall()]
        quality = dict(db.execute(
            """SELECT
                 SUM(CASE WHEN monthly_sold_estimated=0 AND monthly_sold>0 THEN 1 ELSE 0 END) exact_count,
                 SUM(CASE WHEN monthly_sold_estimated=1 THEN 1 ELSE 0 END) estimated_count,
                 SUM(CASE WHEN monthly_sold=0 THEN 1 ELSE 0 END) missing_count
               FROM products"""
        ).fetchone())
        movers = [enrich_product(dict(row)) for row in db.execute(
            """SELECT * FROM products
               WHERE monthly_sold_delta<>0 OR historical_sold_delta<>0 OR price_delta<>0
               ORDER BY ABS(monthly_sold_delta) DESC, ABS(historical_sold_delta) DESC LIMIT 8"""
        ).fetchall()]
    return {"categories": categories, "sales_quality": quality, "movers": movers}


@app.get("/api/tasks")
def tasks():
    with connect() as db:
        rows = db.execute("SELECT * FROM tasks ORDER BY id DESC").fetchall()
    return [dict(row) for row in rows]


@app.post("/api/tasks")
async def create_task(request: Request):
    body = await request.json()
    name = str(body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "任务名称不能为空")
    with connect() as db:
        cur = db.execute(
            "INSERT INTO tasks(name,platform,task_type,schedule,status,config_json) VALUES(?,?,?,?,?,?)",
            (name, body.get("platform", "shopee"), body.get("task_type", "商品采集"),
             body.get("schedule", "手动"), "待配置", json.dumps(body.get("config", {}), ensure_ascii=False)),
        )
        task_id = cur.lastrowid
    add_log("任务中心", f"创建任务：{name}")
    return {"ok": True, "id": task_id}


@app.get("/api/logs")
def logs(limit: int = 100):
    with connect() as db:
        rows = db.execute("SELECT * FROM logs ORDER BY id DESC LIMIT ?", (min(limit, 500),)).fetchall()
    return [dict(row) for row in rows]


def safe_cell(value: Any) -> Any:
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@"):
        return "'" + value
    return value


def export_rows(kind: str) -> tuple[list[str], list[dict[str, Any]]]:
    if kind == "reviews":
        columns = ["platform", "review_id", "item_id", "shop_id", "rating", "comment", "variant", "review_time", "likes", "media_count"]
        query = "SELECT " + ",".join(columns) + " FROM reviews ORDER BY review_time DESC"
    else:
        columns = [
            "platform", "item_id", "shop_id", "title", "category", "price", "price_delta",
            "historical_sold", "historical_sold_text", "historical_sold_estimated", "historical_sold_delta",
            "monthly_sold", "monthly_sold_text", "monthly_sold_estimated", "monthly_sold_delta",
            "rating", "review_count", "created_at", "shop_name", "shop_location", "capture_count",
            "is_favorite", "note", "last_changed_at", "imported_at", "product_url", "image_url",
        ]
        query = "SELECT " + ",".join(columns) + " FROM products ORDER BY historical_sold DESC"
    with connect() as db:
        rows = [dict(row) for row in db.execute(query).fetchall()]
    return columns, rows


@app.get("/api/export/{kind}.csv")
def export_csv(kind: str):
    if kind not in {"products", "reviews"}:
        raise HTTPException(404)
    columns, rows = export_rows(kind)
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=columns)
    writer.writeheader()
    for row in rows:
        writer.writerow({k: safe_cell(v) for k, v in row.items()})
    data = "\ufeff" + buffer.getvalue()
    headers = {"Content-Disposition": f'attachment; filename="{kind}.csv"'}
    return Response(data.encode("utf-8"), media_type="text/csv; charset=utf-8", headers=headers)


@app.get("/api/export/{kind}.xlsx")
def export_xlsx(kind: str):
    if kind not in {"products", "reviews"}:
        raise HTTPException(404)
    columns, rows = export_rows(kind)
    wb = Workbook()
    ws = wb.active
    ws.title = "商品" if kind == "products" else "评论"
    ws.append(columns)
    for row in rows:
        ws.append([safe_cell(row.get(column)) for column in columns])
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions
    output = io.BytesIO()
    wb.save(output)
    headers = {"Content-Disposition": f'attachment; filename="{kind}.xlsx"'}
    return StreamingResponse(io.BytesIO(output.getvalue()), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headers=headers)


@app.get("/api/system")
def system_info():
    return {
        "version": "0.6.1",
        "database": str(DB_PATH),
        "connectors": {"shopee": "Chrome采集助手可用", "shein": "Chrome采集助手可用", "mercadolivre": "待开发"},
        "features": ["Shopee/SHEIN 列表批量采集", "标准品类与手动改类", "Shopee 商品缩略图与历史补图", "SHEIN 自动滚动翻页", "暂停续采", "风控页安全停止", "静默伴随启动", "销量口径切换", "销量上下限", "数据可信度", "变化追踪", "选品参考分", "收藏备注", "评论洞察"],
    }


def use_running_platform(open_browser: bool) -> None:
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        connection = HTTPConnection(PLATFORM_HOST, PLATFORM_PORT, timeout=0.5)
        try:
            connection.request("GET", "/api/system")
            response = connection.getresponse()
            if response.status != 200:
                break
            details = json.loads(response.read(65536))
        except (HTTPClientError, OSError, UnicodeError, ValueError):
            time.sleep(0.25)
            continue
        finally:
            connection.close()
        if not isinstance(details, dict) or not isinstance(details.get("database"), str) or not details.get("connectors"):
            break
        if Path(details["database"]).resolve() != DB_PATH.resolve():
            raise RuntimeError("另一套 LatAmCollector 正在运行。请关闭该服务，或使用它的安装目录。")
        if open_browser:
            webbrowser.open(PLATFORM_URL)
        return
    raise RuntimeError(f"本地端口 {PLATFORM_PORT} 已被占用，请关闭占用该端口的程序后重试。")


def run(open_browser: bool = True) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        if os.name != "nt":
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            listener.bind((PLATFORM_HOST, PLATFORM_PORT))
        except OSError:
            use_running_platform(open_browser)
            return

        server = uvicorn.Server(uvicorn.Config(app, host=PLATFORM_HOST, port=PLATFORM_PORT, log_level="warning"))
        pid_file = DB_PATH.parent / "server.pid"
        pid = str(os.getpid())
        pid_file.write_text(pid, encoding="ascii")

        def open_when_ready() -> None:
            while not server.started and not server.should_exit:
                time.sleep(0.1)
            if server.started and not server.should_exit:
                webbrowser.open(PLATFORM_URL)

        if open_browser:
            threading.Thread(target=open_when_ready, daemon=True).start()
        try:
            server.run(sockets=[listener])
            if not server.started:
                raise RuntimeError("本地服务没有完成启动。")
        finally:
            try:
                if pid_file.read_text(encoding="ascii").strip() == pid:
                    pid_file.unlink()
            except OSError:
                pass

