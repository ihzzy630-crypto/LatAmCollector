from __future__ import annotations

import sqlite3
import sys
from contextlib import contextmanager
from pathlib import Path


def app_directory() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[1]


DATA_DIR = app_directory() / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "latam_collector.db"


@contextmanager
def connect():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def initialize() -> None:
    with connect() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                platform TEXT NOT NULL DEFAULT 'shopee',
                item_id TEXT NOT NULL,
                shop_id TEXT NOT NULL,
                title TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT '未分类',
                price REAL NOT NULL DEFAULT 0,
                historical_sold INTEGER NOT NULL DEFAULT 0,
                monthly_sold INTEGER NOT NULL DEFAULT 0,
                historical_sold_text TEXT,
                monthly_sold_text TEXT,
                rating REAL NOT NULL DEFAULT 0,
                review_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT,
                shop_name TEXT,
                shop_location TEXT,
                product_url TEXT,
                image_url TEXT,
                raw_json TEXT,
                imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(platform, shop_id, item_id)
            );

            CREATE TABLE IF NOT EXISTS reviews (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                platform TEXT NOT NULL DEFAULT 'shopee',
                review_id TEXT NOT NULL,
                item_id TEXT NOT NULL,
                shop_id TEXT NOT NULL,
                rating INTEGER NOT NULL DEFAULT 0,
                comment TEXT,
                variant TEXT,
                review_time TEXT,
                likes INTEGER NOT NULL DEFAULT 0,
                media_count INTEGER NOT NULL DEFAULT 0,
                imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(platform, review_id)
            );

            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                platform TEXT NOT NULL,
                task_type TEXT NOT NULL,
                schedule TEXT,
                status TEXT NOT NULL DEFAULT '待配置',
                config_json TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                level TEXT NOT NULL DEFAULT 'INFO',
                source TEXT NOT NULL,
                message TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_products_filter
                ON products(platform, category, price, historical_sold, created_at);
            CREATE INDEX IF NOT EXISTS idx_reviews_date ON reviews(review_time);
            """
        )


def add_log(source: str, message: str, level: str = "INFO") -> None:
    with connect() as db:
        db.execute(
            "INSERT INTO logs(level, source, message) VALUES (?, ?, ?)",
            (level, source, message),
        )

