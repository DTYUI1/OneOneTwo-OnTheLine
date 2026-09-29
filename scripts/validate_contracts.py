import json
from pathlib import Path

import yaml
from jsonschema import Draft202012Validator, FormatChecker
from openapi_spec_validator import validate
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[1]


def schema_registry() -> Registry:
    """Все $ref разрешаются локально; проверка не обращается к arm112.local."""
    registry: Registry = Registry()
    for path in (ROOT / "contracts").glob("*.schema.json"):
        schema = json.loads(path.read_text(encoding="utf-8"))
        Draft202012Validator.check_schema(schema)
        registry = registry.with_resource(schema["$id"], Resource.from_contents(schema))
    return registry


def check() -> None:
    """Проверить OpenAPI, примеры и JSON-сценарии для всех потребителей."""
    spec = yaml.safe_load((ROOT / "contracts/openapi.draft.yaml").read_text(encoding="utf-8"))
    validate(spec)
    for filename, name in [
        ("card", "CardSource"),
        ("current", "CardCurrent"),
        ("card-event", "CardEvent"),
    ]:
        local = json.loads((ROOT / f"contracts/{filename}.schema.json").read_text(encoding="utf-8"))
        local.pop("$id")
        local.pop("$schema")
        component = {
            key: value
            for key, value in spec["components"]["schemas"][name].items()
            if key != "examples"
        }
        if local != component:
            raise ValueError(f"Расхождение JSON Schema и OpenAPI: {filename}")
    registry = schema_registry().with_resource(
        "urn:openapi",
        Resource.from_contents({"$schema": "https://json-schema.org/draft/2020-12/schema", **spec}),
    )
    registry = registry.with_resource(
        "https://arm112.local/contracts/openapi.json",
        Resource.from_contents({"$schema": "https://json-schema.org/draft/2020-12/schema", **spec}),
    )
    for name, schema in spec["components"]["schemas"].items():
        validator = Draft202012Validator(
            {"$ref": f"urn:openapi#/components/schemas/{name}"},
            registry=registry,
            format_checker=FormatChecker(),
        )
        for example in schema.get("examples", []):
            validator.validate(example)
    for methods in spec["paths"].values():
        for operation in methods.values():
            for response in operation["responses"].values():
                for content in response.get("content", {}).values():
                    if "example" in content:
                        Draft202012Validator(
                            {"components": spec["components"], **content["schema"]},
                            registry=registry,
                            format_checker=FormatChecker(),
                        ).validate(content["example"])
    scenario = Draft202012Validator(
        {"$ref": "https://arm112.local/contracts/scenario.schema.json"},
        registry=registry,
        format_checker=FormatChecker(),
    )
    for path in (ROOT / "data/templates").glob("*.json"):
        scenario.validate(json.loads(path.read_text(encoding="utf-8")))
    cases = list((ROOT / "data/golden_scenarios").glob("*.json"))
    if len(cases) < 10:
        raise ValueError("Нужно минимум 10 golden-фикстур")
    event_validator = Draft202012Validator(
        {"$ref": "https://arm112.local/contracts/card-event.schema.json"},
        registry=registry,
        format_checker=FormatChecker(),
    )
    for path in cases:
        case = json.loads(path.read_text(encoding="utf-8"))
        Draft202012Validator(
            {"$ref": "https://arm112.local/contracts/golden.schema.json"},
            registry=registry,
            format_checker=FormatChecker(),
        ).validate(case)
        scenario.validate(case["scenario"])
        for event in case["events"]:
            event_validator.validate(
                {key: event[key] for key in ["client_event_id", "client_ts", "type", "payload"]}
            )
    timing_cases = [
        case
        for name in ["timing-v2.json", "timing-v3.json"]
        for case in json.loads((ROOT / "contracts/examples" / name).read_text(encoding="utf-8"))
    ]
    for case in timing_cases:
        Draft202012Validator(
            {"$ref": "https://arm112.local/contracts/c01.schema.json#/$defs/TimingFixture"},
            registry=registry,
            format_checker=FormatChecker(),
        ).validate(case)
    examples = json.loads((ROOT / "contracts/examples/c01.json").read_text(encoding="utf-8"))
    for name, example in examples.items():
        Draft202012Validator(
            {"$ref": f"https://arm112.local/contracts/c01.schema.json#/$defs/{name}"},
            registry=registry,
            format_checker=FormatChecker(),
        ).validate(example)


if __name__ == "__main__":
    check()
