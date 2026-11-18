from __future__ import annotations

import csv
import io
import json
import sys
import threading
import webbrowser
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse
from openpyxl import Workbook

from .database import DB_PATH, add_log, connect, initialize
from .parser import parse_products, parse_reviews


def resource_path(relative: str) -> Path:
    root = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1]))
    return root / relative


app = FastAPI(title="LatAm Collector", docs_url=None, redoc_url=None)


@app.on_event("startup")
def startup() -> None:
    initialize()


@app.get("/", response_class=HTMLResponse)
def home():
    return FileResponse(resource_path("static/index.html"))


@app.get("/api/stats")
def stats():
    with connect() as db:
        product_count = db.execute("SELECT COUNT(*) FROM products").fetchone()[0]
        review_count = db.execute("SELECT COUNT(*) FROM reviews").fetchone()[0]
        qualified = db.execute(
            """SELECT COUNT(*) FROM products
               WHERE price >= 32 AND historical_sold >= 1000
                 AND substr(created_at, 1, 4) = '2024'"""
        ).fetchone()[0]
        task_count = db.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]
    return {"products": product_count, "reviews": review_count, "qualified": qualified, "tasks": task_count}


def product_query(params: dict[str, Any]) -> tuple[str, list[Any]]:
    where = ["1=1"]
    values: list[Any] = []
    mapping = {
        "platform": "platform = ?",
        "category": "category = ?",
        "year": "substr(created_at, 1, 4) = ?",
    }
    for key, clause in mapping.items():
        if params.get(key):
            where.append(clause)
            values.append(params[key])
    if params.get("min_price") not in (None, ""):
        where.append("price >= ?")
        values.append(float(params["min_price"]))
    if params.get("min_sales") not in (None, ""):
        where.append("historical_sold >= ?")
        values.append(int(params["min_sales"]))
    if params.get("q"):
        where.append("(title LIKE ? OR shop_name LIKE ?)")
        term = "%" + str(params["q"]) + "%"
        values.extend([term, term])
    return " AND ".join(where), values


@app.get("/api/products")
def products(
    platform: str = "",
    category: str = "",
    year: str = "",
    min_price: str = "",
    min_sales: str = "",
    q: str = "",
    page: int = 1,
    page_size: int = 50,
):
    page = max(page, 1)
    page_size = min(max(page_size, 1), 200)
    where, values = product_query(locals())
    with connect() as db:
        total = db.execute("SELECT COUNT(*) FROM products WHERE " + where, values).fetchone()[0]
        rows = db.execute(
            "SELECT * FROM products WHERE " + where + " ORDER BY historical_sold DESC, id DESC LIMIT ? OFFSET ?",
            values + [page_size, (page - 1) * page_size],
        ).fetchall()
    return {"total": total, "items": [dict(row) for row in rows]}


@app.get("/api/reviews")
def reviews(year_from: int = 2025, year_to: int = 2026, page: int = 1, page_size: int = 50):
    page_size = min(max(page_size, 1), 200)
    page = max(page, 1)
    with connect() as db:
        total = db.execute(
            "SELECT COUNT(*) FROM reviews WHERE CAST(substr(review_time,1,4) AS INTEGER) BETWEEN ? AND ?",
            (year_from, year_to),
        ).fetchone()[0]
        rows = db.execute(
            """SELECT r.*, p.title FROM reviews r
               LEFT JOIN products p ON p.platform=r.platform AND p.item_id=r.item_id AND p.shop_id=r.shop_id
               WHERE CAST(substr(r.review_time,1,4) AS INTEGER) BETWEEN ? AND ?
               ORDER BY r.review_time DESC LIMIT ? OFFSET ?""",
            (year_from, year_to, page_size, (page - 1) * page_size),
        ).fetchall()
    return {"total": total, "items": [dict(row) for row in rows]}


@app.post("/api/import/json")
async def import_json(request: Request):
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(400, "文件不是有效的 JSON") from exc
    if not isinstance(payload, dict):
        raise HTTPException(400, "JSON 顶层必须是对象")
    products_found = parse_products(payload)
    reviews_found = parse_reviews(payload)
    inserted_products = inserted_reviews = 0
    with connect() as db:
        for p in products_found:
            before = db.total_changes
            db.execute(
                """INSERT INTO products(
                    platform,item_id,shop_id,title,category,price,historical_sold,monthly_sold,
                    historical_sold_text,monthly_sold_text,rating,review_count,created_at,
                    shop_name,shop_location,product_url,image_url,raw_json
                ) VALUES (
                    :platform,:item_id,:shop_id,:title,:category,:price,:historical_sold,:monthly_sold,
                    :historical_sold_text,:monthly_sold_text,:rating,:review_count,:created_at,
                    :shop_name,:shop_location,:product_url,:image_url,:raw_json
                ) ON CONFLICT(platform,shop_id,item_id) DO UPDATE SET
                    title=excluded.title, category=excluded.category, price=excluded.price,
                    historical_sold=excluded.historical_sold, monthly_sold=excluded.monthly_sold,
                    historical_sold_text=excluded.historical_sold_text,
                    monthly_sold_text=excluded.monthly_sold_text, rating=excluded.rating,
                    review_count=excluded.review_count, created_at=excluded.created_at,
                    shop_name=excluded.shop_name, shop_location=excluded.shop_location,
                    product_url=excluded.product_url, image_url=excluded.image_url,
                    raw_json=excluded.raw_json, imported_at=CURRENT_TIMESTAMP""",
                p,
            )
            inserted_products += db.total_changes - before
        for r in reviews_found:
            before = db.total_changes
            db.execute(
                """INSERT INTO reviews(platform,review_id,item_id,shop_id,rating,comment,variant,review_time,likes,media_count)
                   VALUES (:platform,:review_id,:item_id,:shop_id,:rating,:comment,:variant,:review_time,:likes,:media_count)
                   ON CONFLICT(platform,review_id) DO UPDATE SET
                   rating=excluded.rating,comment=excluded.comment,variant=excluded.variant,
                   review_time=excluded.review_time,likes=excluded.likes,media_count=excluded.media_count""",
                r,
            )
            inserted_reviews += db.total_changes - before
    message = f"导入完成：识别商品 {len(products_found)} 条，评论 {len(reviews_found)} 条"
    add_log("数据导入", message)
    return {"ok": True, "message": message, "products": len(products_found), "reviews": len(reviews_found)}


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
        columns = ["platform", "item_id", "shop_id", "title", "category", "price", "historical_sold", "monthly_sold", "rating", "review_count", "created_at", "shop_name", "shop_location", "product_url"]
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
    return {"version": "0.1.0", "database": str(DB_PATH), "connectors": {"shopee": "数据导入可用", "shein": "待开发", "mercadolivre": "待开发"}}


def run() -> None:
    initialize()
    threading.Timer(1.2, lambda: webbrowser.open("http://127.0.0.1:8765")).start()
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")

