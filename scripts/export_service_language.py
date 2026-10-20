#!/usr/bin/env python3
"""Экспорт единого словаря в web; --check сравнивает байты без записи.

Корпус копируется только при явном --corpus-output: ожидания не генерируются парсером.
"""

import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "packages/evalcore/evalcore"
DEFAULT_OUTPUT = ROOT / "apps/web/src/arm/softphone/brigade/serviceLanguage.json"


def main() -> int:
    """Скопировать ровно канонические байты либо проверить актуальность экспорта."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--corpus-output", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    pairs = [(SOURCE / "service_language.json", args.output)]
    if args.corpus_output:
        pairs.append((SOURCE / "service_language_corpus.json", args.corpus_output))
    stale = []
    for source, destination in pairs:
        content = source.read_bytes()
        if args.check:
            if not destination.is_file() or destination.read_bytes() != content:
                stale.append(str(destination))
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
    if stale:
        parser.exit(1, "Устаревший экспорт: " + ", ".join(stale) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
