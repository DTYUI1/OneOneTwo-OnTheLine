"""Точечная проверка экспорта канонических данных без записи frontend-артефактов."""

import json
import subprocess
import sys
from pathlib import Path


def test_export_language_and_normative_corpus(tmp_path):
    root = Path(__file__).resolve().parents[3]
    output = tmp_path / "language.json"
    corpus = tmp_path / "corpus.json"
    command = [
        sys.executable,
        str(root / "scripts/export_service_language.py"),
        "--output",
        str(output),
        "--corpus-output",
        str(corpus),
    ]
    subprocess.run(command, check=True)
    canonical = root / "packages/evalcore/evalcore"
    assert json.loads(output.read_text()) == json.loads(
        (canonical / "service_language.json").read_text()
    )
    assert json.loads(corpus.read_text()) == json.loads(
        (canonical / "service_language_corpus.json").read_text()
    )
    subprocess.run([*command, "--check"], check=True)
    output.write_text("{}")
    assert subprocess.run([*command, "--check"], capture_output=True).returncode != 0
