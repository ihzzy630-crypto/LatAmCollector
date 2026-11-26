import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import database
from app.main import app


class ReviewScopeTests(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(TemporaryDirectory())
        self.enterContext(patch.object(database, "DB_PATH", Path(directory) / "catalog.db"))
        database.initialize()
        with database.connect() as db:
            db.executemany(
                "INSERT INTO products(id, platform, item_id, shop_id, title) VALUES(?, ?, ?, ?, ?)",
                [(1, "shopee", "42", "11", "Caneta"), (2, "shopee", "42", "12", "Caderno"),
                 (3, "shein", "42", "11", "Bolsa")],
            )
            db.executemany(
                """INSERT INTO reviews(review_id, platform, item_id, shop_id, rating, comment, review_time, media_count)
                   VALUES(?, ?, ?, ?, ?, ?, ?, ?)""",
                [("first", "shopee", "42", "11", 5, "Ótima qualidade", "2024-03-31", 1),
                 ("second", "shopee", "42", "11", 2, "Material frágil", "2026-01-02", 0),
                 ("third", "shopee", "42", "11", 0, "Sem nota", None, 0),
                 ("other-shop", "shopee", "42", "12", 4, "Outra loja", "2026-01-01", 0),
                 ("other-platform", "shein", "42", "11", 4, "Outra plataforma", "2026-01-01", 0)],
            )
        self.client = self.enterContext(TestClient(app))

    def test_product_link_limits_reviews_and_charts_to_the_same_platform_and_shop(self):
        params = {"product_id": 1, "all_years": True}
        product = self.client.get("/api/products/1").json()
        self.assertEqual(product["title"], "Caneta")
        self.assertEqual(self.client.get("/api/products/999").status_code, 404)
        reviews = self.client.get("/api/reviews", params=params).json()
        self.assertEqual({r["review_id"] for r in reviews["items"]}, {"first", "second", "third"})
        self.assertEqual({r["product_id"] for r in reviews["items"]}, {1})
        stats = self.client.get("/api/review-insights", params=params).json()
        self.assertEqual((stats["total"], stats["with_media"], stats["stars"]["5"]), (3, 1, 1))
        self.assertEqual(stats["sentiments"]["负向"], 1)

    def test_charts_and_list_apply_the_same_filters_and_legacy_year_defaults(self):
        params = {"product_id": 1, "sentiment": "positive", "topic": "质量做工", "has_media": "1"}
        for route in ("/api/reviews", "/api/review-insights"):
            with self.subTest(route=route):
                self.assertEqual(self.client.get(route, params=params).json()["total"], 0)
                filtered = self.client.get(route, params={**params, "all_years": True}).json()
                self.assertEqual(filtered["total"], 1)
