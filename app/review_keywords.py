from __future__ import annotations

import re
import unicodedata
from collections import Counter
from typing import Iterable

# Each term is counted once per review, even when several forms occur.
PHRASES = (
    ("má qualidade", "质量差", r"(?:ma|baixa|pessima) qualidade|qualidade (?:ruim|baixa|pessima)|nao (?:e )?(?:de )?boa qualidade"),
    ("boa qualidade", "质量好", r"(?:boa|excelente|otima) qualidade|qualidade (?:boa|excelente|otima)"),
    ("chegou rápido", "到货快", r"chegou rapido|entrega (?:muito )?rapid[ao]|chegou antes do prazo"),
    ("entrega demorada", "到货慢", r"entrega demorad[ao]|demorou(?: para chegar)?|atrasou|entrega atrasada"),
    ("bem embalado", "包装完好", r"(?:bem|muito bem) embalad[oa]s?|embalagem intacta"),
    ("embalagem danificada", "包装破损", r"embalagem (?:amassada|aberta|danificada|rasgada)|caixa (?:amassada|quebrada|danificada)"),
    ("não funciona", "无法使用", r"nao funcion[ao]u?|parou de funcionar"),
    ("com defeito", "有缺陷", r"(?:veio |chegou )?com defeito|defeituos[oa]"),
    ("quebrou", "损坏", r"quebrou|quebrad[ao]s?|danificad[ao]s?"),
    ("vale a pena", "值得买", r"vale(?:u)? a pena|custo beneficio|bom preco"),
    ("igual à foto", "与图片一致", r"igual a(?:s)? foto[s]?|conforme (?:a descricao|o anuncio)|como na foto"),
    ("diferente da foto", "与图片不符", r"diferente d[ao] (?:foto|anuncio)|nao (?:e )?como na foto|nao condiz"),
    ("ficou pequeno", "尺寸偏小", r"(?:ficou|veio) pequen[oa]|menor do que|tamanho pequen[oa]"),
    ("ficou grande", "尺寸偏大", r"(?:ficou|veio) grande|maior do que|tamanho grande"),
    ("tamanho certo", "尺寸合适", r"tamanho (?:certo|correto|ideal)|serviu (?:bem|perfeitamente)"),
    ("fácil de usar", "易于使用", r"facil de (?:usar|manusear)|pratico de usar"),
    ("fácil de montar", "安装简单", r"facil de montar|montagem (?:facil|simples)"),
    ("material frágil", "材质易损", r"material fragil|muito fragil"),
    ("material resistente", "材质结实", r"material resistente|bem resistente|muito resistente"),
    ("faltam peças", "配件缺失", r"faltam pecas|faltou (?:uma )?peca|pecas faltando|veio incompleto"),
    ("barulho", "噪音", r"barulh[oa]s?|ruido[s]?"),
    ("bateria", "电池", r"bateria[s]?|autonomia"),
    ("confortável", "舒适", r"confortavel|confortaveis|conforto"),
    ("cor", "颜色", r"cor(?:es)?"),
    ("tecido", "面料", r"tecido[s]?"),
    ("qualidade", "质量", r"qualidade"),
    ("entrega", "配送", r"entrega[s]?|prazo[s]?"),
    ("embalagem", "包装", r"embalage(?:m|ns)"),
    ("tamanho", "尺寸", r"tamanho[s]?|medida[s]?"),
    ("preço", "价格", r"preco[s]?|valor"),
)
COMPILED_PHRASES = tuple((term, chinese, re.compile(r"\b(?:" + forms + r")\b")) for term, chinese, forms in PHRASES)
LABELS = {term: chinese for term, chinese, _ in PHRASES}
STOPWORDS = set("""
    agora ainda algo alguns assim aqui atravez cada cela coisa coisas como compra compras comprei comprar comprou
    conforme comigo mesmo mesma dessa desse desta deste disso entre essa esse esta estava estavam estamos esta
    este estao feito fiz foram fotos foto gente gostei gostou igual iria isso isto muito muita muitos muitas mais
    melhor menos minha minhas meu meus nada ninguen nosso nossa outra outras outro outros para pelo pelos pela
    pelas pode podem porque quando quem quero recebemos recebi recomendo sobre sempre sendo sera sejam seria
    somente super tambem tanto todas todos tinha tido voce voces obrigado obrigada produto produtos adorei
    perfeito perfeita bom boa otimo otima amei legal bem simplesmente com alguma apenas dele deles dela delas
""".split())
STOPWORDS.update({"https", "http", "com", "shopee", "shein"})
WORD = re.compile(r"[^\W\d_]+", re.UNICODE)


def normalize(text: str) -> str:
    return "".join(letter for letter in unicodedata.normalize("NFKD", text.casefold()) if not unicodedata.combining(letter))


def summarize_keywords(rows: Iterable, limit: int = 12) -> list[dict]:
    totals: Counter[str] = Counter()
    positive: Counter[str] = Counter()
    negative: Counter[str] = Counter()
    spelling: dict[str, str] = {}
    for row in rows:
        original = row["comment"] or ""
        if not original.strip():
            continue
        # Tokenize before stripping accents so unexplained words keep their spelling.
        words = WORD.findall(original.casefold())
        remainder = " ".join(normalize(word) for word in words)
        found: set[str] = set()
        for term, _, pattern in COMPILED_PHRASES:
            remainder, matches = pattern.subn(" ", remainder)
            if matches:
                found.add(term)
        remaining = set(remainder.split())
        for word in words:
            key = normalize(word)
            if len(key) >= 4 and key in remaining and key not in STOPWORDS and re.fullmatch("[a-z]+", key):
                spelling.setdefault(key, word)
                found.add(key)
        totals.update(found)
        if row["rating"] >= 4:
            positive.update(found)
        elif 1 <= row["rating"] <= 2:
            negative.update(found)
    selected = sorted(
        (term for term, count in totals.items() if term in LABELS or count > 1),
        key=lambda term: (-totals[term], term not in LABELS, term),
    )[:limit]
    return [
        {
            "text": spelling.get(term, term),
            "chinese": LABELS.get(term, ""),
            "count": totals[term],
            "positive": positive[term],
            "negative": negative[term],
        }
        for term in selected
    ]
