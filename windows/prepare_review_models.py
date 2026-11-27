"""Prepare redistributable OPUS-MT files for the offline Windows installer."""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

from app.review_translation import MODEL_DOWNLOADS, MODEL_FILES


def prepare(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    for name, expected_size, expected_digest in MODEL_DOWNLOADS:
        with tempfile.TemporaryDirectory(prefix="latam-model-") as scratch:
            archive = Path(scratch) / "language.argosmodel"
            subprocess.run(
                [
                    "curl.exe" if os.name == "nt" else "curl",
                    "--fail", "--silent", "--show-error", "--location", "--proto", "=https",
                    "--retry", "2", "--max-time", "120", "--max-filesize", str(expected_size),
                    "--output", str(archive), f"https://argos-net.com/v1/{name}.argosmodel",
                ],
                check=True,
            )
            with archive.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            if archive.stat().st_size != expected_size or digest != expected_digest:
                raise ValueError(f"Checksum mismatch for {name}")
            with zipfile.ZipFile(archive) as model:
                for filename in (*MODEL_FILES, "README.md"):
                    destination = root / name / filename
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with model.open(f"{name}/{filename}") as origin, destination.open("wb") as output:
                        shutil.copyfileobj(origin, output)
            print(f"Prepared offline model {name}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    prepare(parser.parse_args().directory)
