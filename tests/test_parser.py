import json
from pathlib import Path

from app.parser import parse_products, parse_reviews, sold_from_text


def test_portuguese_sold_text():
    assert sold_from_text("100mil+ Vendido(s)") == 100_000
    assert sold_from_text("1,2mil Vendido/Mês") == 1_200
    assert sold_from_text("1.2k sold") == 1_200
    assert sold_from_text("100.000 Vendido(s)") == 100_000
    assert sold_from_text(None) == 0


def test_minimal_product():
    payload = {
        "items": [{
            "item_data": {
                "itemid": 123,
                "shopid": 456,
                "ctime": 1711062000,
                "item_card_display_price": {"price": 10260000},
                "item_card_display_sold_count": {"historical_sold_count_text": "2mil+ Vendido(s)"},
                "item_rating": {"rating_star": 4.8, "rating_count": [99]},
            },
            "item_card_displayed_asset": {"name": "Parafusadeira 21V"},
        }]
    }
    item = parse_products(payload)[0]
    assert item["price"] == 102.60
    assert item["historical_sold"] == 2_000
    assert item["category"] == "五金工具"
    assert item["created_at"].startswith("2024-")
    assert item["historical_sold_estimated"] == 1


def test_product_detail_payload():
    payload = {
        "data": {
            "itemid": 11,
            "shopid": 22,
            "name": "Kit Ferramentas",
            "price": 4490000,
            "historical_sold": 3200,
            "monthly_sold": 850,
            "ctime": 1733500000,
            "item_rating": {"rating_star": 4.7, "rating_count": [250]},
        }
    }
    item = parse_products(payload)[0]
    assert item["price"] == 44.9
    assert item["historical_sold"] == 3200
    assert item["monthly_sold"] == 850
    assert item["historical_sold_estimated"] == 0


def test_shopee_image_shapes_and_item_basic():
    payload = {
        "data": {
            "items": [{
                "item_basic": {
                    "itemid": 9988,
                    "shopid": 7766,
                    "name": "Produto com imagem",
                    "price": 3290000,
                    "images": [{"md5": "br-11134207-example"}],
                }
            }]
        }
    }
    item = parse_products(payload, "shopee")[0]
    assert item["image_url"] == "https://down-br.img.susercontent.com/file/br-11134207-example"

    payload["data"]["items"][0]["item_basic"]["images"] = ["https://example.com/product.jpg"]
    item = parse_products(payload, "shopee")[0]
    assert item["image_url"] == "https://example.com/product.jpg"


def test_shein_normalized_page_products():
    payload = {
        "latam_collector": {"platform": "shein", "kind": "products"},
        "data": {
            "products": [{
                "goods_id": "998877",
                "goods_name": "Vestido Feminino Elegante",
                "sale_price_text": "R$96,95",
                "sold_num_text": "7,2k+ vendido",
                "comment_rank_average": "4.8",
                "category_name": "Vestidos femininos",
                "mall_name": "SHEIN",
                "product_url": "https://br.shein.com/Vestido-p-998877.html",
                "goods_img": "//img.ltwebstatic.com/example.webp",
            }]
        },
    }
    item = parse_products(payload)[0]
    assert item["platform"] == "shein"
    assert item["item_id"] == "998877"
    assert item["price"] == 96.95
    assert item["historical_sold"] == 7_200
    assert item["historical_sold_estimated"] == 1
    assert item["monthly_sold"] == 0
    assert item["image_url"].startswith("https://")


def test_shein_api_product_and_millisecond_timestamp():
    payload = {
        "data": {
            "goods": [{
                "goods_id": 123456,
                "goods_name": "Organizador de cozinha",
                "salePrice": {"amount": "69.99", "amountWithSymbol": "R$69,99"},
                "sold_num": 2300,
                "comment_num": 321,
                "comment_rank_average": 4.7,
                "create_time": 1733500000000,
                "mall_code": "BR001",
            }]
        }
    }
    item = parse_products(payload, "shein")[0]
    assert item["price"] == 69.99
    assert item["historical_sold"] == 2300
    assert item["historical_sold_estimated"] == 0
    assert item["review_count"] == 321
    assert item["created_at"].startswith("2024-")


def test_shein_sales_label_can_arrive_in_separate_nested_node():
    payload = {
        "data": {
            "items": [
                {
                    "goods_id": "777",
                    "goods_name": "Calça feminina",
                    "salePrice": {"amount": "53.93"},
                },
                {
                    "goods_id": "777",
                    "sellingPoint": {"labels": [{"text": "1,9k+ vendido"}]},
                },
            ]
        }
    }
    item = parse_products(payload, "shein")[0]
    assert item["historical_sold"] == 1900
    assert item["historical_sold_text"] == "1,9k+ vendido"
    assert item["historical_sold_estimated"] == 1


def test_shein_numeric_string_sales_are_exact():
    payload = {
        "data": {
            "goods": [{
                "goods_id": "778",
                "goods_name": "Blusa feminina",
                "sale_num": "2300",
                "salePrice": {"amount": "25.50"},
            }]
        }
    }
    item = parse_products(payload, "shein")[0]
    assert item["historical_sold"] == 2300
    assert item["historical_sold_estimated"] == 0


def test_shein_reviews():
    payload = {
        "data": {
            "comment_list": [{
                "comment_id": "review-1",
                "goods_id": "998877",
                "comment_rank": 5,
                "content": "Qualidade ótima e entrega rápida",
                "goods_style_name": "Preto / M",
                "comment_time": 1763500000,
                "comment_images": [{"url": "one"}, {"url": "two"}],
                "like_num": 7,
            }]
        }
    }
    item = parse_reviews(payload)[0]
    assert item["platform"] == "shein"
    assert item["review_id"] == "review-1"
    assert item["rating"] == 5
    assert item["media_count"] == 2
    assert item["likes"] == 7
