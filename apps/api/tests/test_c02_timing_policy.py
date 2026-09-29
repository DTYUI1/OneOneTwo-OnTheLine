"""C-02: снимок методики времени занятия (I-TIME v3) и совместимость со старыми занятиями."""

import copy

import pytest
from app.core.contracts import read_json, validate_json

from .test_lifecycle import login

POLICIES = read_json("contracts/c01.schema.json")["$defs"]["TimingPolicy"]["examples"]


@pytest.fixture
def session_body(database_client):
    login(database_client)
    users = {u["login"]: u for u in database_client.get("/api/users").json()}
    settings = {**database_client.get("/api/settings").json()}
    settings.update(reaction_normative_s=25, handling_normative_s=150)
    return {
        "title": "Проверка C-02",
        "participants": [
            {
                "user_id": users["trainee03"]["id"],
                "workstation_number": 3,
                "dds_service_id": "102",
                "level": 1,
            }
        ],
        "settings_snapshot": settings,
    }


def create(client, headers, body, expected=201):
    response = client.post("/api/sessions", json=body, headers=headers)
    assert response.status_code == expected, response.text
    return response.json()


def policy_of(client, session_id):
    response = client.get(f"/api/sessions/{session_id}/lifecycle")
    assert response.status_code == 200, response.text
    validate_json(response.json(), "urn:openapi#/components/schemas/SessionLifecycle")
    return response.json()["timing_policy"]


def test_new_session_gets_v3_with_snapshot_normatives(database_client, session_body):
    headers = login(database_client)
    lesson = create(database_client, headers, session_body)
    assert policy_of(database_client, lesson["id"]) == {
        **POLICIES[1],
        "reaction_normative_s": 25,
        "handling_normative_s": 150,
    }
    # Изменение глобальных /settings не меняет методику уже созданного занятия.
    admin = login(database_client, "admin")
    settings = database_client.get("/api/settings").json()
    changed = {**settings, "handling_normative_s": settings["handling_normative_s"] + 60}
    assert database_client.put("/api/settings", json=changed, headers=admin).status_code == 200
    login(database_client)
    assert policy_of(database_client, lesson["id"])["handling_normative_s"] == 150
    admin = login(database_client, "admin")
    assert database_client.put("/api/settings", json=settings, headers=admin).status_code == 200


@pytest.mark.parametrize("version", [2, 3])
def test_explicit_policy_is_stored_as_given(database_client, session_body, version):
    headers = login(database_client)
    policy = {**POLICIES[version - 2], "reaction_normative_s": 25, "handling_normative_s": 150}
    lesson = create(database_client, headers, {**session_body, "timing_policy": policy})
    assert policy_of(database_client, lesson["id"]) == policy


def test_explicit_null_keeps_legacy_methodology(database_client, session_body):
    headers = login(database_client)
    lesson = create(database_client, headers, {**session_body, "timing_policy": None})
    assert policy_of(database_client, lesson["id"]) is None


@pytest.mark.parametrize(
    "patch,code",
    [
        ({"handling_normative_s": 180}, "timing_policy_mismatch"),
        ({"waiting_policy": "separate"}, None),
        ({"timing_version": 4}, None),
    ],
)
def test_inconsistent_policy_creates_nothing(database_client, session_body, patch, code):
    headers = login(database_client)
    before = database_client.get("/api/sessions").json()
    policy = {**POLICIES[1], "reaction_normative_s": 25, "handling_normative_s": 150, **patch}
    body = copy.deepcopy(session_body) | {"timing_policy": policy}
    response = create(database_client, headers, body, expected=422)
    if code:
        assert response["code"] == code
    assert database_client.get("/api/sessions").json() == before
