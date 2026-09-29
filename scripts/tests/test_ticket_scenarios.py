"""Сценарии по билетам: схема, происхождение, согласие эталона с классификатором и оценщиком."""

import json
import re

from evalcore.criteria import AddressCriterion, RoutingCriterion, StatusFlowCriterion
from evalcore.models import EvalContext
from evalcore.validation import validate_reference
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from scripts.build_ticket_scenarios import OUTPUT, PACK, ROOT, TASKS, outputs

SCHEMA = json.loads((ROOT / "contracts/scenario.schema.json").read_text(encoding="utf-8"))
CARD_SCHEMA = json.loads((ROOT / "contracts/card.schema.json").read_text(encoding="utf-8"))
REGISTRY = Registry().with_resources(
    (schema["$id"], Resource.from_contents(schema)) for schema in (SCHEMA, CARD_SCHEMA)
)
CLASSIFIER = json.loads((ROOT / "data/classifier.json").read_text(encoding="utf-8"))
MAIN = {"MCHS": "101", "Police": "102", "AMBULANCE": "103", "MOSGAZ": "104"}
SETTINGS = json.loads((ROOT / "data/seed/settings.json").read_text(encoding="utf-8"))


def scenarios():
    manifest = json.loads((OUTPUT / "manifest.json").read_text(encoding="utf-8"))
    return [
        (entry, json.loads((ROOT / entry["file"]).read_text(encoding="utf-8")))
        for entry in manifest
    ]


def test_generated_files_are_current():
    for path, content in outputs().items():
        assert path.read_text(encoding="utf-8") == content, path


def test_schema_provenance_and_honest_status():
    validator = Draft202012Validator(SCHEMA, registry=REGISTRY, format_checker=FormatChecker())
    items = scenarios()
    assert len(items) == len(TASKS) == 10
    assert len({s["id"] for _, s in items}) == len({s["card"]["number"] for _, s in items}) == 10
    for entry, scenario in items:
        validator.validate(scenario)
        # Эталон команды до проверки преподавателем не выдаётся за утверждённый.
        assert (scenario["origin"], scenario["status"]) == ("imported", "draft")
        assert entry["teacher_review"] == "not_reviewed"
        assert entry["reference_author"] == "team"
        assert entry["classifier_version"] == "046_24"
        assert f"Билет {entry['ticket']}, задача {entry['task']}" in scenario["teacher_comment"]
        assert re.fullmatch(r"\+7900000\d{4}", scenario["card"]["phone_aon"])
        # Эталонный комментарий и описание не раскрываются из билета дословно как «ответ».
        assert scenario["reference"]["expected_comment"] not in scenario["card"]["description"]
    pack = json.loads(PACK.read_text(encoding="utf-8"))
    assert pack["status"] == "draft"
    assert pack["scenario_ids"] == [scenario["id"] for _, scenario in items]


def test_services_follow_classifier_046_24():
    types = {item["code"]: item for item in CLASSIFIER["incident_types"]}
    rules: dict[str, set[str]] = {}
    for rule in CLASSIFIER["routing_rules"]:
        rules.setdefault(rule["incident_type_code"], set()).add(rule["service_id"])
    for _, scenario in scenarios():
        code = scenario["incident_type_code"]
        assert scenario["card"]["incident_class"] == types[code]["name"]
        allowed = rules.get(code, set()) | {MAIN.get(types[code]["main_service_code"], "")}
        assert set(scenario["card"]["service_ids"]) <= allowed, code
        assert scenario["target_service_id"] in scenario["card"]["service_ids"]


def test_reference_passes_its_own_rules():
    """Эталонное прохождение даёт полный балл по маршруту, статусам и адресу."""
    for _, scenario in scenarios():
        reference = scenario["reference"]
        validate_reference(reference)
        flow = reference["expected_flow"]
        moment = "2026-09-25T00:00:00Z"
        deliver = {"type": "deliver", "payload": {}, "server_ts": moment, "client_ts": moment}
        events = [deliver] + [
            {
                "type": "status_change",
                "payload": {"state": state, "comment": reference["expected_comment"]},
                "server_ts": f"2026-09-25T00:00:{index:02d}Z",
                "client_ts": f"2026-09-25T00:00:{index:02d}Z",
            }
            for index, state in enumerate(flow[1:], start=1)
        ]
        ctx = EvalContext(
            scenario=scenario,
            current={"comment": reference["expected_comment"], "service_number": "77-01"},
            events=events,
            calls=[],
            settings=SETTINGS,
        )
        for criterion in (AddressCriterion(), RoutingCriterion(), StatusFlowCriterion()):
            result = criterion.evaluate(ctx)
            assert result.score == 1.0, (scenario["id"], criterion.key, result.explanation)
