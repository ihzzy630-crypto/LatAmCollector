from __future__ import annotations

import json
import re
import unicodedata
from typing import Any, Iterable


UNCATEGORIZED = "未分类"
CATEGORY_GROUPS = (
    ("家居生活", ("家居百货", "厨房餐饮", "家纺床品", "收纳清洁", "节庆装饰", "庭院园艺")),
    ("办公与工具", ("文具办公", "五金工具", "数码家电", "汽摩用品")),
    ("服饰与个护", ("女装服装", "男装服装", "服装通用", "鞋包配饰", "美妆个护")),
    ("运动与家庭", ("运动户外", "母婴玩具", "宠物用品")),
    ("待整理", (UNCATEGORIZED,)),
)
CATEGORIES = tuple(category for _, group in CATEGORY_GROUPS for category in group)
CATEGORY_ORIGIN_RANK = {"unknown": 0, "legacy": 1, "title": 2, "platform": 3, "manual": 4}


def label_key(value: str) -> str:
    stripped = unicodedata.normalize("NFKD", value.casefold())
    stripped = "".join(char for char in stripped if not unicodedata.combining(char))
    return " ".join(re.findall(r"\w+", stripped))


PLATFORM_LABELS = {
    "家居百货": ("Casa e construção", "Casa e cozinha", "Casa e decoração", "Casa e jardim", "Casa", "Decoração", "Home & Living", "Home & Kitchen", "Home Decor", "Móveis"),
    "厨房餐饮": ("Cozinha e jantar", "Cozinha", "Utensílios de cozinha", "Acessórios de cozinha", "Louças", "Louça e talheres", "Kitchen & Dining", "Kitchenware"),
    "家纺床品": ("Cama, mesa e banho", "Cama e banho", "Roupa de cama", "Roupas de cama", "Têxteis para casa", "Bedding", "Home Textiles"),
    "收纳清洁": ("Organização e armazenamento", "Limpeza doméstica", "Limpeza", "Organização", "Armazenamento", "Household Cleaning", "Storage & Organization"),
    "节庆装饰": ("Decoração de Natal", "Natal", "Festas e eventos", "Decorações para festas", "Festividades", "Party Supplies", "Christmas Decorations"),
    "庭院园艺": ("Jardim e área externa", "Jardinagem", "Jardim", "Garden & Outdoor", "Garden Supplies"),
    "文具办公": ("Papelaria", "Escrita e correção", "Cadernos e papéis", "Artigos de escritório", "Equipamento escolar e de escritório", "Material escolar", "Papelaria e escritório", "Office & School Supplies", "Stationery"),
    "五金工具": ("Ferramentas", "Ferramentas manuais", "Ferramentas elétricas", "Ferramentas e acessórios", "Ferragens", "Tools & Hardware", "Power Tools", "Hand Tools"),
    "数码家电": ("Eletrônicos", "Celulares e acessórios", "Áudio e vídeo", "Informática", "Eletrodomésticos", "Electronics", "Home Appliances"),
    "汽摩用品": ("Automóveis e motos", "Automotivo", "Autopeças", "Acessórios para carros", "Automotive", "Car Accessories"),
    "女装服装": ("Moda feminina", "Roupas femininas", "Vestidos femininos", "Vestidos", "Blusas femininas", "Women Clothing", "Women's Clothing", "Women Apparel"),
    "男装服装": ("Moda masculina", "Roupas masculinas", "Camisetas masculinas", "Men Clothing", "Men's Clothing", "Men Apparel"),
    "服装通用": ("Moda", "Roupas", "Vestuário", "Clothing"),
    "鞋包配饰": ("Calçados", "Sapatos", "Bolsas", "Bolsas e bagagens", "Acessórios de moda", "Joias e relógios", "Shoes", "Bags", "Jewelry & Accessories"),
    "美妆个护": ("Beleza", "Beleza e cuidados pessoais", "Maquiagem", "Cuidados com a pele", "Cuidados pessoais", "Beauty & Personal Care", "Makeup", "Skincare"),
    "运动户外": ("Esporte e lazer", "Esportes e atividades ao ar livre", "Esportes e fitness", "Fitness", "Sports & Outdoors"),
    "母婴玩具": ("Bebês e crianças", "Bebês", "Maternidade e bebê", "Brinquedos e jogos", "Brinquedos", "Baby & Maternity", "Toys & Games"),
    "宠物用品": ("Animais de estimação", "Pet shop", "Produtos para animais de estimação", "Acessórios para pets", "Pet Supplies"),
}
LABEL_TO_CATEGORY = {label_key(category): category for category in CATEGORIES if category != UNCATEGORIZED}
LABEL_TO_CATEGORY.update({
    label_key(label): category for category, labels in PLATFORM_LABELS.items() for label in labels
})

# The known Shopee global_cat path includes these catalogue groups.
SHOPEE_CATEGORY_IDS = {
    "100709": "家居百货",
    "100710": "家纺床品",
    "100711": "家居百货",
    "100713": "家居百货",
    "100715": "五金工具",
    "100716": "收纳清洁",
    "100717": "厨房餐饮",
    "100718": "厨房餐饮",
    "100721": "收纳清洁",
}

CATEGORY_FIELDS = (
    "category_path", "categoryPath", "breadcrumbs", "category_name", "categoryName",
    "cat_name", "catName", "categories", "category", "global_cat", "category_id", "catid",
)
NESTED_CATEGORY_FIELDS = ("path", "name", "label", "id", *CATEGORY_FIELDS)
REFINEMENTS = {
    "家居百货": {"厨房餐饮", "家纺床品", "收纳清洁", "节庆装饰", "庭院园艺"},
    "服装通用": {"女装服装", "男装服装"},
}

TITLE_PATTERNS = {
    "节庆装饰": r"papai noel|arvores? de natal|enfeites? de natal|pisca pisca|guirlandas?|enfeites? de festa",
    "五金工具": r"ferramentas?|parafusadeiras?|furadeiras?|soquetes?|brocas?|alicates?|martelos?|chaves? (?:catraca|allen|inglesas?|de fenda|de impacto)|serras?|lixadeiras?|multimetros?|compressores?|soldadores?",
    "文具办公": r"canetas?|marcadores?|lapis|cadernos?|papelaria|estojos? escolares?|blocos? de notas|agendas?|clips?|grampeadores?|borrachas? escolares?|marca textos?",
    "厨房餐饮": r"caixas? bento|caixas? de almoco|marmitas?|potes? hermeticos?|panelas?|frigideiras?|assadeiras?|air fryers?|tapioqueiras?|peneiras?|coadores?|facas? de cozinha|utensilios? de cozinha|canecas?|pratos?|talheres?|garrafas? termicas?|porta ovos",
    "家纺床品": r"colchoes?|colchao|lencois?|lencol|edredons?|travesseiros?|fronhas?|capas? de almofada|capas? para colchao|mantas? para cama|toalhas? de banho",
    "收纳清洁": r"organizadores?|cestos?|cabides?|escovas? (?:eletricas? )?de limpeza|limpadores?|mops?|vassouras?|aspiradores?|porta papel higienico|porta shampoo|caixas? organizadoras?",
    "家居百货": r"ganchos? de parede|prateleiras?|tapetes?|capachos?|cortinas?|almofadas?|vasos? decorativos?|quadros? decorativos?|mesas? de cabeceira|luminarias?|portas? toalhas?",
    "庭院园艺": r"jardinagem|regadores?|mangueiras? de jardim|tesouras? de poda|vasos? para plantas|sementes? para jardim",
    "美妆个护": r"escovas? secadoras?|escovas? modeladoras?|escovas? de dentes|secadores? de cabelo|maquiagem|batons?|batom|perfumes?|esmaltes?|skincare|hidratantes?|serum facial",
    "数码家电": r"fones?(?: de ouvido)?|carregadores?|smartwatches?|smartwatch|power banks?|cabos? usb|caixas? de som|cameras?|televisores?|laptops?|teclados?|painel solar",
    "汽摩用品": r"autopecas?|suportes? veiculares?|capas? automotivas?|tapetes? automotivos?|capacetes? de moto|palhetas? para carros",
    "鞋包配饰": r"chaveiros?|bolsas?|mochilas?|sandalias?|sapatos?|tenis|pulseiras?|brincos?|colares?|malas? de viagem",
    "女装服装": r"vestidos?|blusas?|saias?|croppeds?|leggings?|conjuntos? femininos?|shorts? femininos?|moda feminina",
    "男装服装": r"(?:camisetas?|camisas?|calcas?|shorts?|bermudas?|conjuntos?) masculinas?|moda masculina",
    "服装通用": r"camisas?|camisetas?|calcas?|shorts?|bermudas?|agasalhos?|jaquetas?|moletons?",
    "运动户外": r"halteres?|bicicletas?|barracas? de camping|tapetes? de yoga|cordas? de pular|raquetes?|caneleiras?|equipamentos? de academia",
    "母婴玩具": r"brinquedos?|bonecas?|pelucias?|mamadeiras?|chupetas?|fraldas?|carrinhos? de bebe|bercos?|bebes?",
    "宠物用品": r"coleiras?|areia (?:sanitaria|para gatos)|racoes?|bebedouros? para pets|comedouros? para pets|camas? para (?:cachorros?|gatos?|pets)|brinquedos? para (?:caes|cachorros?|gatos?|pets)",
}
TITLE_RULES = tuple((category, re.compile(rf"\b(?:{pattern})\b")) for category, pattern in TITLE_PATTERNS.items())


def category_tokens(value: Any, depth: int = 0) -> Iterable[str]:
    if depth > 4:
        return
    if isinstance(value, dict):
        for key in NESTED_CATEGORY_FIELDS:
            if key in value:
                yield from category_tokens(value[key], depth + 1)
    elif isinstance(value, (list, tuple)):
        for part in reversed(value[:30]):
            yield from category_tokens(part, depth + 1)
    elif isinstance(value, (str, int)) and not isinstance(value, bool):
        for part in reversed(re.split(r"[>»›|]", str(value)[:1000])):
            if 0 < len(part.strip()) <= 80:
                yield label_key(part)


def category_from_metadata(platform: str, sources: Iterable[Any]) -> str | None:
    fallback = None
    for source in sources:
        for token in category_tokens(source):
            category = LABEL_TO_CATEGORY.get(token)
            if not category and platform == "shopee":
                category = SHOPEE_CATEGORY_IDS.get(token)
            if category in REFINEMENTS:
                fallback = fallback or category
            elif category:
                return category
    return fallback


def title_category(title: str) -> str | None:
    clean = re.split(r"\s*(?:[,;]\s+|\|)\s*", title[:350], maxsplit=1)[0]
    head = label_key(clean)
    head = re.split(r"\b(?:ideal para|presente (?:de|para)|para presentear)\b", head, maxsplit=1)[0]
    if re.search(r"\b(?:de|para) natal\b", head):
        return "节庆装饰"
    matches = []
    for category, pattern in TITLE_RULES:
        match = pattern.search(head)
        if match:
            matches.append((match.start(), -len(match.group()), category))
    return min(matches)[2] if matches else None


def classify_product(
    platform: str, title: str, raw: Any = None, *, legacy_category: str = ""
) -> tuple[str, str]:
    nodes = [raw] if isinstance(raw, dict) else []
    if platform == "shopee" and nodes:
        nodes[:0] = [
            raw[key] for key in ("item_data", "item_basic", "item_card_displayed_asset")
            if isinstance(raw.get(key), dict)
        ]
    metadata = (node[key] for node in nodes for key in CATEGORY_FIELDS if key in node)
    platform_category = category_from_metadata(platform, metadata)
    if not platform_category and legacy_category not in CATEGORIES:
        platform_category = category_from_metadata(platform, (legacy_category,))
    if platform_category and platform_category not in REFINEMENTS:
        return platform_category, "platform"
    inferred = title_category(title)
    if inferred and (not platform_category or inferred in REFINEMENTS[platform_category]):
        return inferred, "title"
    if platform_category:
        return platform_category, "platform"
    if legacy_category in CATEGORIES and legacy_category != UNCATEGORIZED:
        return legacy_category, "legacy"
    return UNCATEGORIZED, "unknown"


def classify_stored_product(row: Any, *, reuse_old_category: bool = False) -> tuple[str, str]:
    try:
        raw = json.loads(row["raw_json"] or "{}")
    except (RecursionError, TypeError, ValueError):
        raw = None
    return classify_product(
        row["platform"], row["title"], raw,
        legacy_category=row["category"] if reuse_old_category else "",
    )
