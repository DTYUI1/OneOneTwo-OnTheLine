"""Проверки именно поставки контрактов; алгоритмы и workflow C-02…C-07 не подменяются."""

import asyncio
import copy
import json
from dataclasses import asdict, fields
from datetime import datetime
from uuid import uuid4

import pytest
from app.api.database import create_database_app
from app.api.main import create_app
from app.api.packs.schemas import GenerateInput
from app.core.config import ROOT, Settings, settings
from app.core.contracts import read_json, validate_json
from app.core.db import Database
from app.core.models import Job, ScenarioPack
from evalcore import iteration_contract, timing_contract
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator, FormatChecker, ValidationError
from pydantic import TypeAdapter
from pydantic import ValidationError as PydanticValidationError
from sqlalchemy import select
from starlette.websockets import WebSocketDisconnect

FIXTURES_V2 = read_json("contracts/examples/timing-v2.json")
FIXTURES_V3 = read_json("contracts/examples/timing-v3.json")
FIXTURES = FIXTURES_V2 + FIXTURES_V3
EXAMPLES = read_json("contracts/examples/c01.json")
SPEC = read_json("contracts/openapi.draft.yaml")
DEFINITIONS = read_json("contracts/c01.schema.json")["$defs"]
GENERATE = SPEC["components"]["schemas"]["GenerateInput"]["examples"][0]
PENDING = [
    (path, method, op)
    for path, methods in SPEC["paths"].items()
    for method, op in methods.items()
    if op.get("x-implementation-status") == "contract-ready"
]


def login(client, name="teacher", password="test-password"):
    response = client.post("/api/auth/login", json={"login": name, "password": password})
    assert response.status_code == 200, response.text
    return {"X-CSRF-Token": client.cookies["csrf"]}


@pytest.mark.parametrize("case", FIXTURES, ids=lambda item: item["name"])
def test_timing_dataclass_roundtrip(case):
    for key, model in [
        ("input", timing_contract.TimingInput),
        ("expected", timing_contract.TimingResult),
    ]:
        typed = TypeAdapter(model).validate_python(case[key])
        assert asdict(typed) == case[key]
        validate_json(asdict(typed), f"urn:openapi#/components/schemas/{model.__name__}")
    for event, evidence in zip(case["input"]["events"], case["expected"]["evidence"], strict=True):
        if evidence["source"] == "corrected_client":
            sample = event["clock"]
            parse = datetime.fromisoformat
            midpoint = (
                parse(sample["client_sent_at"]).timestamp()
                + parse(sample["client_received_at"]).timestamp()
            ) / 2
            assert (parse(sample["server_at"]).timestamp() - midpoint) * 1000 == pytest.approx(
                sample["offset_ms"], abs=0.001
            )
            assert parse(evidence["normalized_at"]).timestamp() == pytest.approx(
                parse(event["client_ts"]).timestamp() + sample["offset_ms"] / 1000, abs=0.001
            )


def test_timing_v3_keeps_agreed_numbers_and_v2_meaning():
    """Общий пример поправки 24.09: 0/20/40/190 → 40/170, ожидание 60 → активная 110."""
    v3 = {case["name"]: case["expected"] for case in FIXTURES_V3}
    v2 = {case["name"]: case["expected"] for case in FIXTURES_V2}
    assert all(case["input"]["policy"]["timing_version"] == 3 for case in FIXTURES_V3)
    assert (v3["v3_base_0_20_40_190"]["reaction_s"], v3["v3_base_0_20_40_190"]["handling_s"]) == (
        40,
        170,
    )
    assert v3["v3_base_0_20_40_190"]["active_handling_s"] == 170
    # 40 с до первичного статуса при нормативе 30 — превышение реакции.
    assert v3["v3_base_0_20_40_190"]["reaction_overdue"] is True
    assert (v3["v3_waiting_60"]["handling_s"], v3["v3_waiting_60"]["active_handling_s"]) == (
        170,
        110,
    )
    # Норматив v3 сравнивается с активной обработкой: неизвестное ожидание — не false.
    assert v3["v3_waiting_unknown"]["handling_overdue"] is None
    assert v3["v3_waiting_keeps_active_in_limit"]["handling_s"] == 240
    assert v3["v3_waiting_keeps_active_in_limit"]["handling_overdue"] is False
    assert v3["v3_open_does_not_close_reaction"]["reaction_overdue"] is True
    # Прежний смысл v2 не меняется.
    assert (v2["base_0_20_40_190"]["reaction_s"], v2["base_0_20_40_190"]["handling_s"]) == (20, 170)
    assert v2["waiting_unknown"]["handling_overdue"] is False


@pytest.mark.parametrize(
    "version,waiting_policy", [(2, "exclude_confirmed"), (3, "separate"), (4, "separate")]
)
def test_timing_policy_version_fixes_waiting_semantics(version, waiting_policy):
    policy = {
        **DEFINITIONS["TimingPolicy"]["examples"][0],
        "timing_version": version,
        "waiting_policy": waiting_policy,
    }
    with pytest.raises(ValidationError):
        validate_json(policy, "urn:openapi#/components/schemas/TimingPolicy")


def test_dataclass_and_schema_fields_stay_in_sync():
    for module in [timing_contract, iteration_contract]:
        for name, model in vars(module).items():
            if getattr(model, "__module__", "") != module.__name__ or not hasattr(
                model, "__dataclass_fields__"
            ):
                continue
            definition = DEFINITIONS[name]
            assert {field.name for field in fields(model)} == set(definition["required"])
            assert set(definition["required"]) == set(definition["properties"])


@pytest.mark.parametrize("name", ["PredictionContext", "CalibrationObservation"])
def test_prediction_dataclasses_and_examples_roundtrip(name):
    for value in DEFINITIONS[name]["examples"]:
        typed = TypeAdapter(getattr(iteration_contract, name)).validate_python(value)
        assert asdict(typed) == value
        validate_json(asdict(typed), f"urn:openapi#/components/schemas/{name}")


@pytest.mark.parametrize("normative", [0, -1, None, True, "180"])
def test_prediction_context_requires_positive_snapshot_normatives(normative):
    value = copy.deepcopy(EXAMPLES["PredictionContext"])
    for field in ["reaction_normative_s", "handling_normative_s"]:
        invalid = {**value, "policy": {**value["policy"], field: normative}}
        with pytest.raises(ValidationError):
            validate_json(invalid, "urn:openapi#/components/schemas/PredictionContext")


@pytest.mark.parametrize(
    "patch",
    [
        {"contract_version": 1},
        {"snapshot_id": None},
        {"snapshot_id": "wrong"},
        {"policy": None},
    ],
)
def test_prediction_context_rejects_unknown_snapshot_or_version(patch):
    with pytest.raises(ValidationError):
        validate_json(
            {**EXAMPLES["PredictionContext"], **patch},
            "urn:openapi#/components/schemas/PredictionContext",
        )


@pytest.mark.parametrize("normative", [0.001, 100, 180, 86400])
def test_prediction_context_accepts_positive_finite_normatives(normative):
    value = copy.deepcopy(EXAMPLES["PredictionContext"])
    value["policy"]["handling_normative_s"] = normative
    validate_json(value, "urn:openapi#/components/schemas/PredictionContext")


def test_prediction_context_requires_complete_v2_policy():
    value = copy.deepcopy(EXAMPLES["PredictionContext"])
    value["policy"]["timing_version"] = 1
    with pytest.raises(ValidationError):
        validate_json(value, "urn:openapi#/components/schemas/PredictionContext")
    for field in ["snapshot_id", "policy", "contract_version"]:
        value = dict(EXAMPLES["PredictionContext"])
        del value[field]
        with pytest.raises(ValidationError):
            validate_json(value, "urn:openapi#/components/schemas/PredictionContext")


@pytest.mark.parametrize(
    "patch",
    [
        {"handling_normative_s": 0},
        {"handling_normative_s": -1},
        {"handling_normative_s": True},
        {"timing_quality": "unknown"},
        {"snapshot_id": "wrong"},
    ],
)
def test_calibration_rejects_invalid_normative_and_quality(patch):
    with pytest.raises(ValidationError):
        validate_json(
            {**EXAMPLES["CalibrationObservation"], **patch},
            "urn:openapi#/components/schemas/CalibrationObservation",
        )


def test_calibration_requires_explicit_unknowns():
    for field in ["snapshot_id", "handling_normative_s", "timing_quality"]:
        value = dict(EXAMPLES["CalibrationObservation"])
        value[field] = None
        validate_json(value, "urn:openapi#/components/schemas/CalibrationObservation")
        del value[field]
        with pytest.raises(ValidationError):
            validate_json(value, "urn:openapi#/components/schemas/CalibrationObservation")


@pytest.mark.parametrize("quality", ["verified", "estimated", "invalid", "legacy", None])
def test_calibration_preserves_quality_and_zero_or_missing_time(quality):
    for duration in [0, None]:
        value = {
            **EXAMPLES["CalibrationObservation"],
            "handling_s": duration,
            "timing_quality": quality,
            "timing_version": 1 if quality == "legacy" else 2,
        }
        validate_json(value, "urn:openapi#/components/schemas/CalibrationObservation")
        typed = TypeAdapter(iteration_contract.CalibrationObservation).validate_python(value)
        assert typed.handling_s == duration
        assert typed.timing_quality == quality


@pytest.mark.parametrize(
    "name,patch",
    [
        ("AssignmentBatchInput", {"items": []}),
        ("AssignmentBatchInput", {"request_id": "wrong"}),
        ("ScenarioPreviewInput", {"unexpected": True}),
        ("PackApprovalInput", {"scenarios": []}),
        ("PresentationReceipt", {"audio_version": 0}),
        ("MaterialMetadata", {"purpose": "unknown"}),
    ],
)
def test_invalid_contract_examples(name, patch):
    with pytest.raises(ValidationError):
        validate_json({**EXAMPLES[name], **patch}, f"urn:openapi#/components/schemas/{name}")


@pytest.mark.parametrize("purpose", ["reference", "evaluation"])
def test_material_purpose_matches_metadata(purpose):
    for name in ["Material", "MaterialMetadata"]:
        value = {**EXAMPLES[name], "purpose": purpose}
        validate_json(value, f"https://arm112.local/contracts/c01.schema.json#/$defs/{name}")
        validate_json(value, f"urn:openapi#/components/schemas/{name}")


@pytest.mark.parametrize("name", ["Material", "MaterialMetadata"])
def test_material_purpose_is_required(name):
    value = {key: item for key, item in EXAMPLES[name].items() if key != "purpose"}
    with pytest.raises(ValidationError):
        validate_json(value, f"urn:openapi#/components/schemas/{name}")


@pytest.mark.parametrize("name", ["Material", "MaterialMetadata"])
@pytest.mark.parametrize("purpose", [None, "", "unknown", 42])
def test_material_purpose_rejects_invalid_values(name, purpose):
    with pytest.raises(ValidationError):
        validate_json(
            {**EXAMPLES[name], "purpose": purpose}, f"urn:openapi#/components/schemas/{name}"
        )


@pytest.mark.parametrize(
    "path,method,status,purposes",
    [
        ("/materials", "get", "200", ["reference", "evaluation"]),
        ("/materials", "post", "201", ["reference"]),
        ("/sessions/{id}/materials", "post", "200", ["reference"]),
    ],
)
def test_material_response_examples_preserve_purpose(path, method, status, purposes):
    content = SPEC["paths"][path][method]["responses"][status]["content"]["application/json"]
    # Повторное чтение контрактного JSON, а не проверка ещё не реализованного хранилища.
    value = json.loads(json.dumps(content["example"]))
    Draft202012Validator(
        {"components": SPEC["components"], **content["schema"]},
        format_checker=FormatChecker(),
    ).validate(value)
    materials = value if isinstance(value, list) else [value]
    assert [item["purpose"] for item in materials] == purposes
    assert value == content["example"]
    for item in materials:
        missing = {key: field for key, field in item.items() if key != "purpose"}
        invalid = [missing] if isinstance(value, list) else missing
        with pytest.raises(ValidationError):
            Draft202012Validator(
                {"components": SPEC["components"], **content["schema"]},
                format_checker=FormatChecker(),
            ).validate(invalid)


@pytest.mark.parametrize("request_id", [None, "", "wrong", 42])
def test_generate_rejects_invalid_request_id(request_id):
    body = {
        **GENERATE,
        "options": {**EXAMPLES["GenerateOptions"], "request_id": request_id},
    }
    with pytest.raises(ValidationError):
        validate_json(body, "urn:openapi#/components/schemas/GenerateInput")
    with pytest.raises(PydanticValidationError):
        GenerateInput.model_validate(body)


def test_generate_requires_request_id_inside_options():
    options = {
        key: value for key, value in EXAMPLES["GenerateOptions"].items() if key != "request_id"
    }
    for body in [
        {**GENERATE, "options": options},
        {**GENERATE, "options": options, "request_id": str(uuid4())},
        {**GENERATE, "request_id": str(uuid4())},
    ]:
        with pytest.raises(ValidationError):
            validate_json(body, "urn:openapi#/components/schemas/GenerateInput")
        with pytest.raises(PydanticValidationError):
            GenerateInput.model_validate(body)


def test_generate_accepts_legacy_and_keyed_options():
    options = {**EXAMPLES["GenerateOptions"], "request_id": str(uuid4())}
    for body in [GENERATE, {**GENERATE, "options": options}, {**GENERATE, "options": None}]:
        validate_json(body, "urn:openapi#/components/schemas/GenerateInput")
        assert GenerateInput.model_validate(body).model_dump(exclude_unset=True) == body


def test_generate_v2_payload_requires_keyed_options():
    body = {**GENERATE, "options": EXAMPLES["GenerateOptions"]}
    payload = {
        "contract_version": 2,
        "operation": "generate",
        "request_id": body["options"]["request_id"],
        "pack_id": str(uuid4()),
        "scenario_id": None,
        "expected_version": None,
        "input": body,
    }
    schema = "https://arm112.local/contracts/storage.schema.json#/$defs/C01GenerateJobPayload"
    validate_json(payload, schema)
    for invalid in [
        GENERATE,
        {**GENERATE, "options": None},
        {
            **body,
            "options": {
                key: value for key, value in body["options"].items() if key != "request_id"
            },
        },
    ]:
        with pytest.raises(ValidationError):
            validate_json({**payload, "input": invalid}, schema)
    revision = EXAMPLES["ScenarioRevisionInput"]
    validate_json(
        {
            **payload,
            "operation": "revise",
            "request_id": revision["request_id"],
            "pack_id": None,
            "scenario_id": str(uuid4()),
            "expected_version": revision["version"],
            "input": revision,
        },
        schema,
    )


def assert_generate_pending(client, password):
    body = {**GENERATE, "options": EXAMPLES["GenerateOptions"]}
    path = "/api/packs/generate"
    assert client.post(path, json=body).status_code == 401
    headers = login(client, password=password)
    assert client.post(path, json=body).status_code == 403
    assert client.post(path, json=body, headers={"X-CSRF-Token": "wrong"}).status_code == 403
    for options in [body["options"], body["options"], None]:
        response = client.post(path, json={**body, "options": options}, headers=headers)
        assert response.status_code == 501, response.text
        validate_json(response.json(), "urn:openapi#/components/schemas/Error")
        assert response.json()["code"] == "http_501"
        assert "C-05" in response.json()["message"]
    missing = {key: value for key, value in body["options"].items() if key != "request_id"}
    for options in [
        missing,
        *[{**body["options"], "request_id": value} for value in [None, "", "wrong", 42]],
    ]:
        response = client.post(path, json={**body, "options": options}, headers=headers)
        assert response.status_code == 422, response.text
        validate_json(response.json(), "urn:openapi#/components/schemas/Error")
    for name in ["admin", "trainee01"]:
        headers = login(client, name, password)
        assert client.post(path, json=body, headers=headers).status_code == 403


def test_generate_pending_database_leaves_jobs_and_packs_unchanged(database_client, database_url):
    async def snapshot():
        database = Database(database_url)
        try:
            async with database.sessions() as db:
                return {
                    "jobs": set(await db.scalars(select(Job.id))),
                    "packs": set(await db.scalars(select(ScenarioPack.id))),
                }
        finally:
            await database.close()

    before = asyncio.run(snapshot())
    assert_generate_pending(database_client, "test-password")
    assert asyncio.run(snapshot()) == before


def test_generate_pending_mock_rbac_csrf_and_validation(monkeypatch):
    monkeypatch.setattr(settings, "api_mode", "mock")
    monkeypatch.setattr(settings, "cookie_secure", False)
    with TestClient(create_app()) as client:
        assert_generate_pending(client, settings.demo_password)


def test_export_and_shared_components():
    import importlib.util

    source = importlib.util.spec_from_file_location(
        "sync_c01", ROOT / "scripts/sync_c01_contracts.py"
    )
    module = importlib.util.module_from_spec(source)
    source.loader.exec_module(module)
    module.sync(check=True)
    exported = create_database_app(Settings(_env_file=None, api_mode="database")).openapi()
    assert exported == read_json("contracts/openapi.json")
    for name in DEFINITIONS:
        assert exported["components"]["schemas"][name] == SPEC["components"]["schemas"][name]
    for path, method, operation in PENDING:
        assert exported["paths"][path][method] == operation
        assert "501" in operation["responses"] and operation["x-owner"]


OWN_TESTS_IN_DATABASE = {
    "listMaterials",
    "uploadMaterial",
    "downloadMaterial",
    "assignMaterials",
    "previewScenario",
}


def call_pending(client, path, method, operation, headers=None):
    body = (
        operation.get("requestBody", {})
        .get("content", {})
        .get("application/json", {})
        .get("example")
    )
    return client.request(
        method.upper(),
        "/api" + path.replace("{id}", str(uuid4())).replace("{delivery_id}", str(uuid4())),
        json=body,
        headers=headers or {},
        params={"version": 1} if operation["operationId"] == "downloadInformationAudio" else None,
    )


def assert_pending_routes(client, password, *, database=False):
    for path, method, operation in PENDING:
        assert call_pending(client, path, method, operation).status_code == 401
    for name, role in [("teacher", "teacher"), ("trainee01", "trainee"), ("admin", "admin")]:
        headers = login(client, name, password)
        for path, method, operation in PENDING:
            if (
                database
                and role in operation["x-roles"]
                and operation["operationId"] in OWN_TESTS_IN_DATABASE
            ):
                continue  # C-07 реализован; поведение проверяет test_c07_materials.py.
            response = call_pending(client, path, method, operation, headers)
            expected = 501 if role in operation["x-roles"] else 403
            if (
                database
                and expected == 501
                and operation["operationId"]
                in {
                    "createAssignmentBatch",
                    "listAssignmentBatches",
                    "getSessionLifecycle",
                    "listBrigades",
                    "listCallTargets",
                    "getCardTraining",
                    "downloadInformationAudio",
                    "getAttemptAnalysis",
                    "getSessionAnalytics",
                    "registerClockSample",
                    "getJobProgress",
                    "approvePack",
                    "getScenarioContent",
                }
            ):
                expected = 404  # C-03/C-04/C-06 реализованы; случайный ID ресурса отсутствует.
            assert response.status_code == expected, (operation["operationId"], response.text)
            validate_json(response.json(), "urn:openapi#/components/schemas/Error")
            assert "reference" not in response.json()["details"]
            if role in operation["x-roles"] and method != "get":
                assert call_pending(client, path, method, operation).status_code == 403


def test_pending_database_rbac_csrf_and_no_fake_success(database_client):
    assert_pending_routes(database_client, "test-password", database=True)


def test_pending_mock_rbac_and_no_fake_success(monkeypatch):
    monkeypatch.setattr(settings, "api_mode", "mock")
    monkeypatch.setattr(settings, "cookie_secure", False)
    with TestClient(create_app()) as client:
        assert_pending_routes(client, settings.demo_password)


def assert_v2_clock_pending(client, password):
    login(client, "trainee01", password)
    with client.websocket_connect("/ws") as socket:
        # Оба backend сначала присылают snapshot/presence, порядок может различаться.
        socket.receive_json()
        socket.receive_json()
        socket.send_json(
            {
                "type": "clock.ping.v2",
                "sample_id": str(uuid4()),
                "client_ts": "2026-09-23T00:00:00Z",
            }
        )
        with pytest.raises(WebSocketDisconnect) as caught:
            socket.receive_json()
        assert caught.value.code == 4400


def test_v2_clock_answers_pong_in_database(database_client):
    # C-02 реализован в database; mock остаётся spec-first и закрывает 4400.
    login(database_client, "trainee01")
    sample_id = str(uuid4())
    with database_client.websocket_connect("/ws") as socket:
        socket.send_json(
            {"type": "clock.ping.v2", "sample_id": sample_id, "client_ts": "2026-09-23T00:00:00Z"}
        )
        while (message := socket.receive_json())["type"] != "clock.pong.v2":
            pass
    assert message["payload"] == {"sample_id": sample_id, "client_ts": "2026-09-23T00:00:00Z"}


def test_v2_clock_is_explicitly_pending_in_mock(monkeypatch):
    monkeypatch.setattr(settings, "api_mode", "mock")
    monkeypatch.setattr(settings, "cookie_secure", False)
    with TestClient(create_app()) as client:
        assert_v2_clock_pending(client, settings.demo_password)


def test_database_extensions_are_explicit_and_atomic(database_client):
    client = database_client
    headers = login(client)
    before = client.get("/api/sessions").json()
    session = copy.deepcopy(SPEC["components"]["schemas"]["SessionInput"]["examples"][0])
    # C-02 реализован: противоречие политики и нормативов снимка отклоняется целиком.
    session["timing_policy"] = {
        **DEFINITIONS["TimingPolicy"]["examples"][0],
        "reaction_normative_s": session["settings_snapshot"]["reaction_normative_s"] + 1,
    }
    assert client.post("/api/sessions", json=session, headers=headers).status_code == 422
    assert client.get("/api/sessions").json() == before
    body = EXAMPLES["AssignmentBatchInput"]
    path = f"/api/sessions/{uuid4()}/assignments/batch"
    assert client.post(path, json=body, headers=headers).status_code == 404
    assert client.post(path, json=body, headers=headers).status_code == 404
    assert client.post(path, json={**body, "items": []}, headers=headers).status_code == 422
    assert client.post(path, content="{", headers=headers).status_code == 422
    generate = SPEC["components"]["schemas"]["GenerateInput"]["examples"][0]
    packs = client.get("/api/packs").json()
    assert (
        client.post(
            "/api/packs/generate",
            json={**generate, "options": EXAMPLES["GenerateOptions"]},
            headers=headers,
        ).status_code
        == 501
    )
    assert client.get("/api/packs").json() == packs
    admin_headers = login(client, "admin")
    assert client.post("/api/sessions", json=session, headers=admin_headers).status_code == 403
    headers = login(client)
    assert (
        client.post(
            f"/api/sessions/{uuid4()}/finish", json=EXAMPLES["FinishInput"], headers=headers
        ).status_code
        == 404
    )
    headers = login(client, "trainee01")
    for event_type, payload in [
        ("message_presented", EXAMPLES["PresentationReceipt"]),
        ("message_failed", EXAMPLES["PresentationFailure"]),
        ("brigades_select", {"brigade_ids": [str(uuid4())]}),
    ]:
        event = dict(
            client_event_id=str(uuid4()),
            client_ts="2026-09-23T00:00:00Z",
            type=event_type,
            payload=payload,
        )
        assert (
            client.post(f"/api/cards/{uuid4()}/events", json=event, headers=headers).status_code
            == 404
        )
    clock_event = dict(
        client_event_id=str(uuid4()),
        client_ts="2026-09-23T00:00:00Z",
        type="open",
        payload={},
        clock_sample_id=str(uuid4()),
    )
    # C-02 реализован: неизвестная карточка — 404 до проверки образца часов.
    assert (
        client.post(f"/api/cards/{uuid4()}/events", json=clock_event, headers=headers).status_code
        == 404
    )
    teacher_headers = login(client)
    assert (
        client.post(f"/api/cards/{uuid4()}/events", json=event, headers=teacher_headers).status_code
        == 403
    )
