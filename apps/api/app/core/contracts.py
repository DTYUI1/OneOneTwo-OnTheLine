"""Локальная проверка JSON, без сетевого разрешения $ref."""

import json
from functools import lru_cache
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from app.core.config import ROOT


def read_json(path: str) -> Any:
    return json.loads((ROOT / path).read_text(encoding="utf-8"))


@lru_cache
def registry() -> Registry:
    result: Registry = Registry()
    for path in (ROOT / "contracts").glob("*.schema.json"):
        document = json.loads(path.read_text(encoding="utf-8"))
        result = result.with_resource(document["$id"], Resource.from_contents(document))
    document = Resource.from_contents(
        {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            **read_json("contracts/openapi.draft.yaml"),
        }
    )
    # Старый внутренний alias сохраняется; публичный URI совместим также с AJV/TS.
    return result.with_resource("urn:openapi", document).with_resource(
        "https://arm112.local/contracts/openapi.json", document
    )


def validate_json(value: Any, schema: str) -> None:
    Draft202012Validator(
        {"$ref": schema}, registry=registry(), format_checker=FormatChecker()
    ).validate(value)
