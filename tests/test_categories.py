from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import database
from app.categories import CATEGORIES, classify_product
from app.main import app


class ClassificationTests(unittest.TestCase):
    def test_shein_titles_placeholders_and_breadcrumbs(self):
        candidates = (
            ("Gancho de Parede para Chaves e Bolsas", "[goods_name] | SHEIN Brasil", "家居百货"),
            ("Caixa Bento, utensílio e presente de Natal", "Início > New In", "厨房餐饮"),
            ("Luz de Projeção de Natal LED", "Início > Casa e cozinha", "节庆装饰"),
            ("Capas de Almofada Decorativas de Natal", "Capas de Almofada Decorativas de Natal", "节庆装饰"),
            ("Tapete de Banho Oval, ideal para cozinha", "Início > Casa e cozinha", "家居百货"),
            ("Kit 24 Canetas Marcadoras", "Início > Papelaria > Escrita e Correção", "文具办公"),
            ("Produto Variado", "[goods_name] | SHEIN Brasil", "未分类"),
        )
        for title, label, expected in candidates:
            with self.subTest(title=title):
                actual, _ = classify_product("shein", title, {"category_name": label})
                self.assertEqual(actual, expected)

    def test_shopee_source_category_overrides_a_generic_title(self):
        raw = {"item_data": {"global_cat": {"catid": [100636, 100715, 101191]}}}
        self.assertEqual(classify_product("shopee", "Kit azul em caixa", raw), ("五金工具", "platform"))
        self.assertEqual(classify_product("shein", "Kit azul em caixa", raw), ("未分类", "unknown"))


class CategoryApiTests(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(TemporaryDirectory())
        self.enterContext(patch.object(database, "DB_PATH", Path(directory) / "catalog.db"))
        database.initialize()
        with database.connect() as db:
            # Recreate the form of this table used before category metadata was added.
            db.execute("ALTER TABLE products DROP COLUMN category_origin")
            db.executemany(
                """INSERT INTO products(platform,item_id,shop_id,title,category,price,monthly_sold,
                                        image_url,raw_json,is_favorite,note,capture_count)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                [
                    ("shein", "111", "shein", "Caixa Bento", "Caixa Bento, presente de Natal", 46, 0,
                     "https://img.ltwebstatic.com/test.jpg", '{"category_name":"Início > New In"}', 1, "候选", 7),
                    ("shein", "222", "shein", "Cortina de porta de Natal", "Cortina de porta de Natal", 45, 0,
                     None, '{"categoryName":"Casa e cozinha"}', 0, "", 1),
                    ("shopee", "333", "444", "Kit 60 Canetas Marcadoras", "未分类", 39, 1200,
                     None, "{malformed", 0, "", 1),
                    ("shopee", "555", "444", "Lápis de cor", "未分类", 10, 10, None, "", 0, "", 1),
                ],
            )
        self.client = self.enterContext(TestClient(app))

    def test_backfill_preserves_saved_product_fields_and_aligns_facets(self):
        response = self.client.get(
            "/api/products",
            params={"platform": "shein", "min_price": "40", "category": "厨房餐饮"},
        ).json()
        self.assertEqual(response["total"], 1)
        self.assertEqual(response["category_counts"], {"厨房餐饮": 1, "节庆装饰": 1})
        item = response["items"][0]
        self.assertEqual(item["category"], "厨房餐饮")
        self.assertEqual(item["category_origin"], "title")
        self.assertEqual((item["is_favorite"], item["note"], item["capture_count"]), (1, "候选", 7))
        self.assertTrue(item["image_url"].endswith("test.jpg"))
        options = self.client.get("/api/product-options?platform=shopee").json()
        self.assertEqual(options["category_counts"], {"文具办公": 2})
        self.assertTrue(all(label in CATEGORIES for label in options["categories"]))
        priced = self.client.get("/api/products?platform=shopee&min_price=32&min_sales=1000").json()
        self.assertEqual(priced["category_counts"], {"文具办公": 1})

    def test_manual_category_survives_capture_and_can_return_to_auto(self):
        url = "/api/products/1"
        self.assertEqual(self.client.patch(url, json={"category": "自定义长标题"}).status_code, 400)
        self.assertEqual(self.client.patch(url, json={"category": "收纳清洁"}).status_code, 200)
        payload = {
            "latam_collector": {"platform": "shein"},
            "data": {"products": [{"goods_id": 111, "goods_name": "Caixa Bento", "category_name": "Cozinha e jantar"}]},
        }
        self.assertEqual(self.client.post("/api/import/json", json=payload).status_code, 200)
        database.normalize_existing_categories()
        selected = self.client.get("/api/products?category=收纳清洁").json()["items"][0]
        self.assertEqual(selected["category_origin"], "manual")
        self.assertEqual(self.client.patch(url, json={"category": None}).status_code, 200)
        restored = self.client.get("/api/products?category=厨房餐饮").json()["items"][0]
        self.assertEqual(restored["category_origin"], "platform")
        self.assertEqual(restored["id"], selected["id"])
        self.assertEqual(restored["note"], "候选")
        self.assertIn("厨房餐饮", self.client.get("/api/export/products.csv").text)
