"""Перенести общие C-01 JSON-схемы в spec-first OpenAPI без ручного копирования."""

import argparse
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


def openapi_refs(value: Any) -> Any:
    """Локальные определения становятся компонентами; старые типы переиспользуются."""
    if isinstance(value, dict):
        return {key: openapi_refs(item) for key, item in value.items()}
    if isinstance(value, list):
        return [openapi_refs(item) for item in value]
    if isinstance(value, str):
        return (
            value.replace("#/$defs/", "#/components/schemas/")
            .replace("urn:openapi#/components/schemas/", "#/components/schemas/")
            .replace(
                "https://arm112.local/contracts/openapi.json#/components/schemas/",
                "#/components/schemas/",
            )
        )
    return value


def sync(*, check: bool = False) -> None:
    """Проверить или обновить только общие компоненты C-01."""
    path = ROOT / "contracts/openapi.draft.yaml"
    original = path.read_text(encoding="utf-8")
    spec = json.loads(original)
    definitions = json.loads((ROOT / "contracts/c01.schema.json").read_text(encoding="utf-8"))
    for name, schema in definitions["$defs"].items():
        spec["components"]["schemas"][name] = openapi_refs(schema)
    content = json.dumps(spec, ensure_ascii=False, indent=2) + "\n"
    if check:
        if content != original:
            raise ValueError("Компоненты C-01 устарели: python scripts/sync_c01_contracts.py")
    else:
        path.write_text(content, encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    sync(check=parser.parse_args().check)
