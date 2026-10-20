"""PR1-04: недоступный обязательный абонент не прерывает действующую тренировку."""

from copy import deepcopy
from datetime import timedelta
from types import SimpleNamespace

import pytest
from app.api.foundation.schemas import Settings
from app.api.sessions import practice
from app.core.models import Scenario
from evalcore.defaults import DEFAULT_PHONE_CONTACTS

from . import test_c03_sessions as c03
from .test_c04_completion import seed_training
from .test_debrief_path import T0, attempt
from .test_lifecycle import login, run_db
from .test_practice_catalog import household_scenario


@pytest.fixture
def caller_practice(database_client, database_url):
    seed_training(database_url)
    scenario = household_scenario(database_url)
    assert scenario.reference["expected_call"]["required"] is True
    assert scenario.reference["expected_call"]["contact_role"] == "caller"
    client = database_client
    headers = login(client, "trainee03")
    response = client.post(f"/api/practice?scenario={scenario.id}", headers=headers)
    assert response.status_code == 200, response.text
    session = response.json()
    c03.tick(database_url)
    card = next(
        item for item in client.get("/api/cards").json() if item["session_id"] == session["id"]
    )
    try:
        yield client, headers, scenario, session, card
    finally:
        for item in client.get("/api/sessions").json():
            if item["kind"] == "practice" and item["status"] == "running":
                finished = client.post(f"/api/sessions/{item['id']}/finish", headers=headers)
                assert finished.status_code == 200, finished.text


def configure_contacts(monkeypatch, service_id, contacts):
    original = practice.training_settings

    async def settings(db):
        row = await original(db)
        value = deepcopy(row.value)
        value["phone_contacts"] = {service_id: contacts}
        # Контрпример обязан пройти настоящий контракт настроек, а не обходить его.
        validated = Settings.model_validate(value).model_dump(mode="json")
        return SimpleNamespace(value=validated)

    monkeypatch.setattr(practice, "training_settings", settings)


def exhausted_contacts():
    return [
        *deepcopy(DEFAULT_PHONE_CONTACTS),
        *[
            {"role": "head", "name": f"Руководитель {number}", "number": number}
            for number in ("405", "406", "407", "408", "409")
        ],
    ]


def practice_query(entrypoint, scenario, card, database_url):
    if entrypoint in {"again_step", "repeat"}:
        attempt(
            database_url,
            "trainee03",
            practice.tutorial_scenario_id(scenario.target_service_id),
            T0,
            total=0.95,
            scores={"status_flow": 1.0},
        )
    if entrypoint == "repeat":
        attempt(
            database_url,
            "trainee03",
            scenario.id,
            T0 + timedelta(hours=1),
            total=0.45,
            scores={"status_flow": 0.5},
        )
        return f"scenario_id={scenario.id}"
    if entrypoint == "again_step":
        return f"again={card['id']}&step=2"
    if entrypoint == "again":
        return f"again={card['id']}"
    return f"scenario={scenario.id}" + (
        f"&demo={entrypoint}" if entrypoint in {"watch", "expert"} else ""
    )


@pytest.mark.parametrize(
    "entrypoint", ["again", "catalog", "again_step", "repeat", "watch", "expert"]
)
def test_again_preserves_running_attempt_when_caller_numbers_are_exhausted(
    caller_practice, database_url, monkeypatch, entrypoint
):
    client, headers, scenario, session, card = caller_practice
    query = practice_query(entrypoint, scenario, card, database_url)
    configure_contacts(monkeypatch, scenario.target_service_id, exhausted_contacts())
    before = client.get("/api/sessions").json()
    lifecycle_before = client.get(f"/api/sessions/{session['id']}/lifecycle").json()
    stopped = []
    stop_attempts = practice.stop_attempts

    async def stop(db, session_id, now):
        stopped.append(session_id)
        await stop_attempts(db, session_id, now)

    monkeypatch.setattr(practice, "stop_attempts", stop)
    response = client.post(f"/api/practice?{query}", headers=headers)
    previous = client.get(f"/api/sessions/{session['id']}").json()
    assert (response.status_code, previous["status"]) == (409, "running"), {
        "http_status": response.status_code,
        "old_session_status": previous["status"],
        "response": response.json(),
    }
    assert response.json()["code"] == "practice_unavailable"
    assert previous["finished_at"] is None
    assert client.get("/api/sessions").json() == before
    assert client.get(f"/api/cards/{card['id']}").json() == card
    assert client.get(f"/api/sessions/{session['id']}/lifecycle").json() == lifecycle_before
    assert stopped == []


@pytest.mark.parametrize("entrypoint", ["again", "catalog", "again_step", "repeat"])
@pytest.mark.parametrize("phone", ["default", "405_busy", "configured"])
def test_start_keeps_automatic_and_configured_caller(
    caller_practice, database_url, monkeypatch, entrypoint, phone
):
    client, headers, scenario, session, card = caller_practice
    query = practice_query(entrypoint, scenario, card, database_url)
    contacts = list(deepcopy(DEFAULT_PHONE_CONTACTS))
    if phone == "405_busy":
        contacts.append({"role": "head", "name": "Другой руководитель", "number": "405"})
    elif phone == "configured":
        contacts = [*exhausted_contacts(), {"role": "caller", "name": "Заявитель", "number": "450"}]
    configure_contacts(monkeypatch, scenario.target_service_id, contacts)
    response = client.post(f"/api/practice?{query}", headers=headers)
    assert response.status_code == 200, response.text
    current = response.json()
    actual = current["settings_snapshot"]["phone_contacts"][scenario.target_service_id]
    number = {"default": "405", "405_busy": "406", "configured": "450"}[phone]
    assert [item["number"] for item in actual if item["role"] == "caller"] == [number]
    assert actual[: len(contacts)] == contacts
    assert client.get(f"/api/sessions/{session['id']}").json()["status"] == "finished"
    assert client.get(f"/api/sessions/{current['id']}").json()["status"] == "running"


@pytest.mark.parametrize("required", [True, False, None])
def test_required_contact_uses_effective_service_phone(
    caller_practice, database_url, monkeypatch, required
):
    client, headers, scenario, session, card = caller_practice

    async def change(db, reference):
        (await db.get(Scenario, scenario.id)).reference = reference

    call = {"contact_role": "head"}
    if required is not None:
        call["required"] = required
    run_db(database_url, lambda db: change(db, {**scenario.reference, "expected_call": call}))
    configure_contacts(monkeypatch, scenario.target_service_id, [])
    try:
        response = client.post(f"/api/practice?again={card['id']}", headers=headers)
        expected = 409 if required else 200
        assert response.status_code == expected, response.text
        assert client.get(f"/api/sessions/{session['id']}").json()["status"] == (
            "running" if required else "finished"
        )
    finally:
        run_db(database_url, lambda db: change(db, scenario.reference))


@pytest.mark.parametrize("query", ["", "step=1"])
def test_tutorial_start_checks_caller_before_stopping_old_attempt(
    caller_practice, database_url, monkeypatch, query
):
    client, headers, _, session, _ = caller_practice
    service = client.get("/api/auth/me").json()["dds_service_id"]

    async def change(db, reference=None):
        row = await db.get(Scenario, practice.tutorial_scenario_id(service))
        original = deepcopy(row.reference)
        row.reference = (
            reference
            if reference is not None
            else {
                **row.reference,
                "expected_call": {"required": True, "contact_role": "caller"},
            }
        )
        return original

    original = run_db(database_url, change)
    configure_contacts(monkeypatch, service, exhausted_contacts())
    try:
        response = client.post(f"/api/practice?{query}", headers=headers)
        assert response.status_code == 409, response.text
        assert response.json()["code"] == "practice_unavailable"
        assert client.get(f"/api/sessions/{session['id']}").json()["status"] == "running"
    finally:
        run_db(database_url, lambda db: change(db, original))
