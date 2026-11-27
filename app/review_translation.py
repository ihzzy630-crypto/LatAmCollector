from __future__ import annotations

import logging
import re
import threading
from collections import OrderedDict
from pathlib import Path

from . import database
from .review_keywords import summarize_keywords

logger = logging.getLogger(__name__)
MODEL_DOWNLOADS = (
    ("translate-pt_en-1_9", 69_447_231, "ae76df6f650895c16f2b582065014fab496755ca846ecb19fae81d51f332a38e"),
    ("translate-en_zh-1_9", 70_743_021, "433e7c4f034d87fbe2353161e05f18646d7999452f801a4e1f0378522b9850ab"),
)
MODEL_FILES = ("sentencepiece.model", "model/config.json", "model/shared_vocabulary.json", "model/model.bin")
PRODUCT_COMMENTS = """(r.platform,r.shop_id,r.item_id) =
    (SELECT platform,shop_id,item_id FROM products WHERE id=?) AND trim(r.comment)<>''"""
TRANSLATION_JOIN = "LEFT JOIN review_translations t ON t.review_id=r.id AND t.source_text=r.comment"

_lock = threading.Lock()
_pending: OrderedDict[int, None] = OrderedDict()
_active: int | None = None
_worker: threading.Thread | None = None
_errors: dict[int, str] = {}


def models_path() -> Path:
    return database.app_directory() / "review_models"


def _model_exists(path: Path) -> bool:
    return all((path / part).is_file() for part in MODEL_FILES)


def models_ready() -> bool:
    root = models_path()
    return all(_model_exists(root / name) for name, _, _ in MODEL_DOWNLOADS)


class LocalTranslator:
    def __init__(self, root: Path):
        import ctranslate2
        import sentencepiece

        self.models = []
        for name, _, _ in MODEL_DOWNLOADS:
            path = root / name
            tokenizer = sentencepiece.SentencePieceProcessor(model_proto=(path / "sentencepiece.model").read_bytes())
            # Load with Python file I/O so Windows paths can contain Chinese characters.
            files = {Path(part).name: (path / part).read_bytes() for part in MODEL_FILES if part.startswith("model/")}
            model = ctranslate2.Translator(name, device="cpu", compute_type="int8", intra_threads=2, files=files)
            self.models.append((model, tokenizer))

    def translate(self, texts: list[str]) -> list[str]:
        # A review can contain several sentences, and pasted text may exceed a model's input size.
        # Batch short pieces while keeping their order and the unmodified original in the database.
        first_tokenizer = self.models[0][1]
        owners: list[int] = []
        parts: list[str] = []
        translated = [[] for _ in texts]
        for index, text in enumerate(texts):
            if not re.search(r"[A-Za-zÀ-ÿ]", text):
                translated[index].append(text)
                continue
            for sentence in re.split(r"(?<=[.!?…])\s+|\n+", text.strip()):
                if not sentence:
                    continue
                # Portuguese reviews often omit the subject in delivery descriptions.
                sentence = re.sub(
                    r"(^|[,;]\s+)(chegou|veio|foi entregue)\b",
                    lambda match: match[1] + ("O produto " if not match[1] else "o produto ") + match[2].lower(),
                    sentence, flags=re.I,
                )
                tokens = first_tokenizer.encode(sentence, out_type=str)
                for offset in range(0, len(tokens), 160):
                    parts.append(first_tokenizer.decode(tokens[offset:offset + 160]))
                    owners.append(index)
        for model, tokenizer in self.models:
            if not parts:
                break
            tokens = tokenizer.encode(parts, out_type=str)
            results = model.translate_batch(
                tokens, beam_size=3, max_batch_size=1024, batch_type="tokens", max_decoding_length=260,
            )
            parts = [tokenizer.decode(result.hypotheses[0]).replace("▁", " ").strip() for result in results]
        for owner, part in zip(owners, parts):
            if part:
                translated[owner].append(part)
        return [" ".join(parts).strip() for parts in translated]


def keywords(product_id: int) -> list[dict]:
    with database.connect() as db:
        rows = db.execute("SELECT r.comment,r.rating FROM reviews r WHERE " + PRODUCT_COMMENTS, (product_id,))
        terms = summarize_keywords(rows)
        for term in terms:
            if not term["chinese"]:
                translation = db.execute(
                    "SELECT translated_text FROM review_keyword_translations WHERE source_text=?",
                    (term["text"],),
                ).fetchone()
                if translation:
                    term["chinese"] = translation[0]
    return terms


def status(product_id: int) -> dict:
    with database.connect() as db:
        counts = db.execute(
            f"SELECT COUNT(*),COUNT(t.review_id) FROM reviews r {TRANSLATION_JOIN} WHERE {PRODUCT_COMMENTS}",
            (product_id,),
        ).fetchone()
    ready = models_ready()
    with _lock:
        if _active == product_id:
            state = "translating"
        elif product_id in _pending:
            state = "queued"
        elif product_id in _errors:
            state = "error"
        else:
            state = "ready" if ready else "needs_models"
        return {
            "state": state, "models_ready": ready, "translated": counts[1], "total": counts[0],
            "error": _errors.get(product_id, ""),
        }


def enqueue(product_id: int) -> None:
    global _worker
    with _lock:
        if product_id in _pending or not models_ready():
            return
        _errors.pop(product_id, None)
        _pending[product_id] = None
        if _worker is None:
            _worker = threading.Thread(target=_run, name="review-translation", daemon=True)
            _worker.start()


def _translate_product(product_id: int, translator: LocalTranslator) -> None:
    last_id = 0
    blank_translations = 0
    while True:
        with database.connect() as db:
            rows = db.execute(
                f"""SELECT r.id,r.comment FROM reviews r {TRANSLATION_JOIN}
                    WHERE {PRODUCT_COMMENTS} AND t.review_id IS NULL AND r.id>?
                    ORDER BY r.id LIMIT 16""",
                (product_id, last_id),
            ).fetchall()
        if not rows:
            break
        last_id = rows[-1]["id"]
        results = translator.translate([row["comment"] for row in rows])
        values = [(row["id"], row["comment"], translated) for row, translated in zip(rows, results) if translated]
        blank_translations += len(rows) - len(values)
        with database.connect() as db:
            db.executemany(
                """INSERT INTO review_translations(review_id,source_text,translated_text)
                   SELECT id,comment,?3 FROM reviews WHERE id=?1 AND comment=?2
                   ON CONFLICT(review_id) DO UPDATE SET
                   source_text=excluded.source_text,translated_text=excluded.translated_text""",
                values,
            )
    untranslated = [term["text"] for term in keywords(product_id) if not term["chinese"]]
    if untranslated:
        results = translator.translate(untranslated)
        with database.connect() as db:
            db.executemany(
                "INSERT OR REPLACE INTO review_keyword_translations VALUES (?,?)",
                [(word, result) for word, result in zip(untranslated, results) if result],
            )
    if blank_translations:
        raise RuntimeError(f"有 {blank_translations} 条评论未生成译文，可以重试")


def _run() -> None:
    global _active, _worker
    translator = None
    while True:
        with _lock:
            if not _pending:
                _active = None
                _worker = None
                return
            product_id, _ = _pending.popitem(last=False)
            _errors.pop(product_id, None)
            _active = product_id
        try:
            if translator is None:
                translator = LocalTranslator(models_path())
            _translate_product(product_id, translator)
        except Exception as error:
            logger.exception("Offline translation failed for product %s", product_id)
            # Keep partial results and expose a short message without dumping review text or local paths.
            message = str(error) if type(error) is RuntimeError and str(error).startswith("有 ") else "本机翻译未完成，请稍后重试"
            with _lock:
                _errors[product_id] = message
        finally:
            with _lock:
                _active = None
