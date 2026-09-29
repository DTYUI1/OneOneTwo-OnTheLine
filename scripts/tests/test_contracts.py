import importlib.util
import json
from pathlib import Path

from evalcore.classifier import parse_classifier

ROOT = Path(__file__).resolve().parents[2]


def test_contracts_and_fixtures():
    spec = importlib.util.spec_from_file_location(
        "validate_contracts", ROOT / "scripts/validate_contracts.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.check()


def test_classifier_artifact_is_reproducible():
    from dataclasses import asdict

    artifact = json.loads((ROOT / "data/classifier.json").read_text(encoding="utf-8"))
    # Основная редакция — 046_24 (решение капитана 24.09); источник указан в артефакте.
    assert artifact["version"] == "046_24"
    types, rules = parse_classifier(ROOT / artifact["source"])
    assert artifact["incident_types"] == [asdict(item) for item in types]
    assert artifact["routing_rules"] == [asdict(rule) for rule in rules]
    assert len(types) == 1283
    assert len({item.code for item in types}) == len(types)
    assert all(rule.payload.casefold() != "нет реагирования" for rule in rules)


def test_seed_references():
    users = json.loads((ROOT / "data/seed/demo_users.json").read_text(encoding="utf-8"))
    phones = json.loads((ROOT / "data/phonebook.json").read_text(encoding="utf-8"))
    services = {item["id"] for item in phones}
    cases = [
        json.loads(path.read_text(encoding="utf-8"))
        for path in (ROOT / "data/golden_scenarios").glob("*.json")
    ]
    assert {case["scenario"]["target_service_id"] for case in cases} == services
    assert {case["scenario"]["level"] for case in cases} == {1, 2, 3, 4}
    assert len({item["phone_ext"] for item in phones}) == 6
    assert all(len(item["phone_ext"]) == 3 for item in phones)
    assert all(user["dds_service_id"] in services for user in users if user["role"] == "trainee")
    assert {user["login"] for user in users} == {
        "admin",
        "teacher",
        "trainee01",
        "trainee02",
        "trainee03",
        "trainee04",
        "trainee05",
    }
