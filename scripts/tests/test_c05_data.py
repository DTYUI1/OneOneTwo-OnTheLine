import hashlib
import json

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from scripts.build_c05_packs import bundles
from scripts.inventory_c05_sources import ROOT, inventory


def test_source_inventory_is_exact_and_does_not_claim_official_solutions():
    stored = json.loads((ROOT / "data/source_inventory.json").read_text(encoding="utf-8"))
    assert stored == inventory()
    for entry in stored["files"]:
        if entry["status"] == "present":
            assert (
                hashlib.sha256((ROOT / entry["path"]).read_bytes()).hexdigest() == entry["sha256"]
            )
    assert {entry["kind"] for entry in stored["missing_sources"]} >= {
        "official_ticket_solutions",
        "service_phone_registry",
        "moscow_streets",
    }
    present = {entry["kind"] for entry in stored["files"] if entry["status"] == "present"}
    withheld = {entry["kind"] for entry in stored["files"] if entry["status"] == "withheld"}
    # Датасет 24.09: билеты и памятка есть, но готовых решений к ним нет.
    # В публичной копии памятки нет (персональные данные сотрудников) — она «withheld».
    assert "official_tickets" in present
    assert "dds_memo" in present | withheld
    assert not any(entry["kind"] == "official_ticket_solutions" for entry in stored["files"])
    external = stored["external_observations"]
    assert len(external["files"]) == 10
    assert sum(item["same_as"] is not None for item in external["files"]) == 6
    assert {item["kind"] for item in external["files"]} >= {
        "phone_datasheet",
        "operator_112_card_instruction",
    }
    assert all(item["status"] == "observed_external" for item in external["files"])
    for item in external["files"]:
        if item["same_as"]:
            assert (
                hashlib.sha256((ROOT / item["same_as"]).read_bytes()).hexdigest() == item["sha256"]
            )


def test_three_draft_bundles_have_30_distinct_valid_scenarios():
    scenarios = []
    scenario_schema = json.loads(
        (ROOT / "contracts/scenario.schema.json").read_text(encoding="utf-8")
    )
    card_schema = json.loads((ROOT / "contracts/card.schema.json").read_text(encoding="utf-8"))
    registry = Registry().with_resources(
        (schema["$id"], Resource.from_contents(schema)) for schema in (scenario_schema, card_schema)
    )
    validator = Draft202012Validator(
        scenario_schema, registry=registry, format_checker=FormatChecker()
    )
    generated = bundles()
    assert len(generated) == 3
    for name, bundle in generated.items():
        assert (
            json.loads((ROOT / "data/generated_packs" / name).read_text(encoding="utf-8")) == bundle
        )
        assert bundle["status"] == "draft"
        assert len(bundle["previews"]) == 10
        for preview in bundle["previews"]:
            scenario = preview["scenario"]
            validator.validate(scenario)
            assert scenario["status"] == "draft"
            assert preview["provenance"]["synthetic"] is True
            scenarios.append(scenario)
    assert len({scenario["id"] for scenario in scenarios}) == 30
    assert {scenario["target_service_id"] for scenario in scenarios} == {
        "101",
        "102",
        "103",
        "104",
        "GKH",
        "MOSLIFT",
    }
    assert {scenario["level"] for scenario in scenarios} == {1, 2, 3, 4}
    assert len({scenario["incident_type_code"] for scenario in scenarios}) >= 6
