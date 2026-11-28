from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import database, review_translation
from app.main import app


class ReviewCaptureAnalysisTests(TestCase):
    def setUp(self):
        folder = Path(self.enterContext(TemporaryDirectory()))
        self.enterContext(patch.object(database, "DB_PATH", folder / "test.db"))
        database.initialize()
        with database.connect() as db:
            db.executemany(
                """INSERT INTO products(id,platform,shop_id,item_id,title,product_url)
                   VALUES(?,?,?,?,?,?)""",
                [
                    (1, "shopee", "12", "441", "Caneta", "https://shopee.com.br/product/12/441"),
                    (2, "shopee", "20", "441", "Outra loja", "https://shopee.com.br/product/20/441"),
                    (3, "shein", "m1", "441", "Bolsa", "https://br.shein.com/Bolsa-p-441.html"),
                ],
            )
        self.client = self.enterContext(TestClient(app))

    def capture_shopee(self, ratings, *, shop="12", page="https://shopee.com.br/product/12/441"):
        response = self.client.post("/api/capture", json={
            "page_url": page,
            "source_url": f"https://shopee.com.br/api/v2/item/get_ratings?shopid={shop}&itemid=441",
            "payload": {"data": {"ratings": ratings, "has_more": False}},
        })
        self.assertEqual(response.status_code, 200)
        return response.json()

    def scoped_reviews(self, product_id):
        return self.client.get("/api/reviews", params={"product_id": product_id, "all_years": True}).json()["items"]

    def test_review_receipt_only_acknowledges_rows_written_for_the_open_product(self):
        reviews = [
            {"cmtid": "first", "rating_star": 5, "comment": "Chegou rápido"},
            {"cmtid": "foreign", "itemid": 441, "shopid": 20, "rating_star": 2, "comment": "Outra loja"},
        ]
        result = self.capture_shopee(reviews)
        self.assertEqual(result["review_batch"], {
            "platform": "shopee", "shop_id": "12", "item_id": "441", "ids": ["first"], "last_page": True,
        })
        self.assertEqual(self.capture_shopee(reviews)["new_reviews"], 0)
        self.assertEqual([row["review_id"] for row in self.scoped_reviews(1)], ["first"])
        self.assertEqual([row["review_id"] for row in self.scoped_reviews(2)], ["foreign"])

        wrong_request = self.capture_shopee([{"cmtid": "unverified", "comment": "sem id"}], shop="20")
        self.assertIsNone(wrong_request["review_batch"])
        collision = self.capture_shopee([{"cmtid": "foreign", "comment": "conteúdo conflitante"}])
        self.assertIsNone(collision["review_batch"])
        self.assertEqual(self.scoped_reviews(2)[0]["comment"], "Outra loja")

    def test_shein_review_fills_the_shop_for_a_unique_known_item(self):
        result = self.client.post("/api/capture", json={
            "page_url": "https://br.shein.com/Bolsa-p-441.html",
            "source_url": "https://br.shein.com/api/comment/abccommentinfo/query",
            "payload": {"data": {"commentList": [
                {"goods_id": 441, "comment_id": "r-1", "comment_rank": 5, "comment": "Tamanho certo"},
                {"goods_id": 442, "comment_id": "r-2", "comment_rank": 3, "comment": "Outro produto"},
            ]}},
        }).json()
        self.assertEqual(result["review_batch"]["ids"], ["r-1"])
        self.assertEqual(self.scoped_reviews(3)[0]["shop_id"], "m1")

    def test_keywords_count_distinct_reviews_and_keep_chinese_with_the_source(self):
        self.capture_shopee([
            {"cmtid": "good", "rating_star": 5, "comment": "Chegou rápido, chegou rápido, bem embalado."},
            {"cmtid": "bad", "rating_star": 2, "comment": "Não é de boa qualidade. Chegou rápido."},
        ])
        result = self.client.get("/api/products/1/review-keywords").json()
        terms = {term["chinese"]: term for term in result["keywords"]}
        self.assertEqual((terms["到货快"]["count"], terms["到货快"]["positive"], terms["到货快"]["negative"]), (2, 1, 1))
        self.assertIn("质量差", terms)
        self.assertNotIn("质量好", terms)

    def test_edited_comments_do_not_show_outdated_chinese_translations(self):
        class TranslateFixture:
            def translate(self, texts):
                return ["到货很快" for _ in texts]

        self.capture_shopee([{"cmtid": "comment", "rating_star": 5, "comment": "Chegou rápido"}])
        review_translation._translate_product(1, TranslateFixture())
        self.assertEqual(self.scoped_reviews(1)[0]["translation"], "到货很快")
        self.assertIn("到货很快", self.client.get("/api/export/reviews.csv").text)
        self.capture_shopee([{"cmtid": "comment", "rating_star": 2, "comment": "Demorou para chegar"}])
        self.assertIsNone(self.scoped_reviews(1)[0]["translation"])
        self.assertEqual(self.client.get("/api/products/1/review-translation").json()["translated"], 0)

    def test_keyword_filters_match_mention_counts_and_respect_product_scope(self):
        self.capture_shopee([
            {"cmtid": "quality-good", "rating_star": 5, "comment": "Qualidade excelente, excelente qualidade."},
            {"cmtid": "quality-poor", "rating_star": 2, "comment": "Não é de boa qualidade."},
            {"cmtid": "fast-1", "rating_star": 4, "comment": "A entrega foi boa. Chegou antes do prazo."},
        ])
        self.capture_shopee(
            [{"cmtid": "other-shop", "rating_star": 5, "comment": "Boa qualidade."}],
            shop="20", page="https://shopee.com.br/product/20/441",
        )
        terms = self.client.get("/api/products/1/review-keywords").json()["keywords"]
        quality = next(term for term in terms if term["chinese"] == "质量好")
        self.assertEqual(quality["count"], 1)
        params = {"all_years": True, "product_id": 1, "keyword": quality["key"]}
        response = self.client.get("/api/reviews", params=params).json()
        self.assertEqual([row["review_id"] for row in response["items"]], ["quality-good"])
        self.assertEqual(self.client.get("/api/review-insights", params=params).json()["total"], quality["count"])
        self.assertEqual(self.client.get("/api/reviews", params={**params, "sentiment": "negative"}).json()["total"], 0)
        all_terms = self.client.get("/api/review-keywords").json()["keywords"]
        self.assertEqual(next(term["count"] for term in all_terms if term["key"] == quality["key"]), 2)
