import copy
import json
from pathlib import Path

import pytest
from evalcore.scenario import ScenarioBuildError, ScenarioGenerator, build

ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture(scope="module")
def classifier():
    return json.loads((ROOT / "data/classifier.json").read_text(encoding="utf-8"))


@pytest.fixture
def constructor():
    return {
        "incident_type_code": "2020000",
        "target_service_id": "102",
        "address": {
            "city": "Москва",
            "okrug": "Северный",
            "district": "Учебный",
            "street": "Дубнинская улица",
            "house": "1",
            "building": "",
            "apartment": "",
        },
        "victims": True,
        "complications": [],
        "level": 2,
        "weight": 7,
        "seed": 42,
    }


def test_deterministic_draft_and_classifier_routing(classifier, constructor):
    generator = ScenarioGenerator(classifier)
    first = generator(constructor)
    assert first == build(copy.deepcopy(constructor), classifier=copy.deepcopy(classifier))
    assert first["scenario"]["status"] == "draft"
    assert first["scenario"]["card"]["service_ids"] == ["102", "103"]
    assert first["scenario"]["reference"]["expected_service_ids"] == ["102", "103"]
    assert first["scenario"]["reference"]["expected_call"]["phone_ext"] == "102"
    assert first["provenance"]["synthetic"] is True
    assert first["scenario"]["weight"] == 7
    assert first["suggested_weight"] != first["scenario"]["weight"]
    assert generator({**constructor, "seed": 43})["scenario"]["id"] != first["scenario"]["id"]
    assert generator(constructor) == first


def test_visible_address_discrepancy_has_correct_reference(classifier, constructor):
    constructor["complications"] = ["wrong_address", "no_phone", "emergency"]
    preview = ScenarioGenerator(classifier)(constructor)
    assert preview["validation_errors"][0]["code"] == "dds_address_policy_unresolved"
    result = preview["scenario"]
    assert result["card"]["address"]["street"] != result["reference"]["expected_address"]["street"]
    assert "Дубнинская улица" in result["card"]["description"]
    assert "уточнил" in result["card"]["description"]
    assert result["card"]["phone_aon"] == ""
    assert result["card"]["emergency"] is True


@pytest.mark.parametrize(
    ("field", "value", "path"),
    [
        ("incident_type_code", "not-a-code", "incident_type_code"),
        ("target_service_id", "104", "target_service_id"),
        ("level", 5, "level"),
        ("victims", 1, "victims"),
        ("complications", ["wrong_address", "wrong_address"], "complications"),
    ],
)
def test_invalid_constructor_fails_closed(classifier, constructor, field, value, path):
    constructor[field] = value
    with pytest.raises(ScenarioBuildError) as exc:
        ScenarioGenerator(classifier)(constructor)
    assert exc.value.path == path


def test_unrepresented_classifier_condition_is_not_assumed(classifier, constructor):
    constructor["incident_type_code"] = "1010101"
    constructor["target_service_id"] = "101"
    constructor["victims"] = False
    services = ScenarioGenerator(classifier)(constructor)["scenario"]["reference"][
        "expected_service_ids"
    ]
    # Column 28 (gasification) and 22 (offence) need flags missing from the constructor.
    assert "104" not in services
    assert "102" not in services
    assert "101" in services


def test_missing_no_access_flag_does_not_activate_fire_rule(classifier, constructor):
    catalog = copy.deepcopy(classifier)
    catalog["routing_rules"].append(
        {
            "incident_type_code": "2020000",
            "service_id": "101",
            "condition": {
                "kind": "classifier_column",
                "column": 14,
                "label": "нет доступа не выбран",
            },
            "payload": "тест",
        }
    )
    services = ScenarioGenerator(catalog)(constructor)["scenario"]["reference"][
        "expected_service_ids"
    ]
    assert "101" not in services


def test_scenario_matches_schema(classifier, constructor):
    jsonschema = pytest.importorskip("jsonschema")
    from referencing import Registry, Resource

    scenario_schema = json.loads(
        (ROOT / "contracts/scenario.schema.json").read_text(encoding="utf-8")
    )
    card_schema = json.loads((ROOT / "contracts/card.schema.json").read_text(encoding="utf-8"))
    registry = Registry().with_resources(
        (schema["$id"], Resource.from_contents(schema)) for schema in (scenario_schema, card_schema)
    )
    validator = jsonschema.Draft202012Validator(
        scenario_schema, registry=registry, format_checker=jsonschema.FormatChecker()
    )
    validator.validate(ScenarioGenerator(classifier)(constructor)["scenario"])


def test_preview_matches_c01_contract(classifier, constructor):
    jsonschema = pytest.importorskip("jsonschema")
    from referencing import Registry, Resource

    c01 = json.loads((ROOT / "contracts/c01.schema.json").read_text(encoding="utf-8"))
    openapi = json.loads((ROOT / "contracts/openapi.json").read_text(encoding="utf-8"))
    openapi["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    registry = Registry().with_resources(
        (
            (c01["$id"], Resource.from_contents(c01)),
            (
                "https://arm112.local/contracts/openapi.json",
                Resource.from_contents(openapi),
            ),
        )
    )
    validator = jsonschema.Draft202012Validator(
        {"$ref": f"{c01['$id']}#/$defs/ScenarioPreview"},
        registry=registry,
        format_checker=jsonschema.FormatChecker(),
    )
    validator.validate(ScenarioGenerator(classifier)(constructor))
