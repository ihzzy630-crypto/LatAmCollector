import json
from pathlib import Path

from app.parser import parse_products, sold_from_text


def test_portuguese_sold_text():
    assert sold_from_text("100mil+ Vendido(s)") == 100_000
    assert sold_from_text("1,2mil Vendido/Mês") == 1_200
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
