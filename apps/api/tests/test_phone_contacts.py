"""Телефон ДДС (GP-09, рекомендации 16.10, п. 8): абоненты задаёт преподаватель, до 10 на ДДС.

Номер вне справочника и вне списка ДДС занятия не отвечает; заявитель доступен, только если
преподаватель включил его в список.
"""

import copy
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from app.api.database import create_database_app
from app.api.foundation.schemas import Settings
from app.core.models import Call
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import select

from . import test_c03_sessions as c03
from .test_c04_training import event
from .test_lifecycle import login, run_db
from .test_settings_validation import valid_settings


def contacts(count: int, start: int = 410) -> list[dict]:
    return [
        {"role": "head", "name": f"Абонент {index + 1}", "number": str(start + index)}
        for index in range(count)
    ]


def test_ten_contacts_per_dds_eleventh_rejected():
    assert (
        len(
            Settings.model_validate(
                {**valid_settings(), "phone_contacts": {"101": contacts(10)}}
            ).phone_contacts["101"]
        )
        == 10
    )
    for bad in (
        contacts(11),
        [*contacts(1), *contacts(1)],
        [{"role": "head", "name": "Служба", "number": "103"}],
        [{"role": "boss", "name": "Кто-то", "number": "450"}],
    ):
        with pytest.raises(ValidationError):
            Settings.model_validate({**valid_settings(), "phone_contacts": {"101": bad}})


def test_eleventh_contact_not_saved_in_lesson(database_client):
    """Преподаватель задаёт абонентов в настройках занятия: 11-й — 422, занятие не создаётся."""
    client = database_client
    headers = login(client)
    settings = client.get("/api/settings").json()
    count = len(client.get("/api/sessions", headers=headers).json())
    users = {u["login"]: u for u in client.get("/api/users").json()}
    participant = {
        "user_id": users["trainee02"]["id"],
        "workstation_number": 2,
        "dds_service_id": "101",
        "level": 2,
    }
    for number, status in ((11, 422), (10, 201)):
        response = client.post(
            "/api/sessions",
            headers=headers,
            json={
                "title": f"Телефон ДДС, {number} абонентов",
                "participants": [participant],
                "settings_snapshot": {**settings, "phone_contacts": {"101": contacts(number)}},
            },
        )
        assert response.status_code == status, response.text
        if status == 422:
            assert "phone_contacts" in response.text
    saved = response.json()
    assert saved["settings_snapshot"]["phone_contacts"]["101"] == contacts(10)
    assert len(client.get("/api/sessions", headers=headers).json()) == count + 1
    client.post(
        f"/api/sessions/{saved['id']}/finish",
        headers=headers,
        json={"contract_version": 2, "request_id": str(uuid4())},
    )


@pytest.fixture
def phone(database_client, database_config, database_url):
    """Занятие, где у ДДС первого участника — руководитель (450) и заявитель (460)."""
    client = database_client
    headers = login(client)
    users = {u["login"]: u for u in client.get("/api/users").json()}
    template = next(s for s in client.get("/api/scenarios").json() if s["status"] == "approved")
    body = copy.deepcopy(template)
    body["id"] = str(uuid4())
    scenario = client.post("/api/scenarios", json=body, headers=headers).json()
    dds = scenario["target_service_id"]
    participants = [
        {
            "user_id": users["trainee01"]["id"],
            "workstation_number": 1,
            "dds_service_id": dds,
            "level": 2,
        }
    ]
    settings = {
        **client.get("/api/settings").json(),
        "phone_contacts": {
            dds: [
                {"role": "head", "name": "Руководитель организации", "number": "450"},
                {"role": "caller", "name": "Заявитель", "number": "460"},
            ]
        },
    }
    response = client.post(
        "/api/sessions",
        headers=headers,
        json={"title": "Телефон ДДС", "participants": participants, "settings_snapshot": settings},
    )
    assert response.status_code == 201, response.text
    lesson = SimpleNamespace(
        client=client,
        headers=headers,
        id=response.json()["id"],
        participants=participants,
        scenarios=[scenario],
    )
    c03.batch(lesson, [c03.item(lesson)])
    c03.start(lesson)
    c03.tick(database_url)
    with TestClient(create_database_app(database_config)) as trainee:
        trainee_headers = login(trainee, "trainee01")
        card = next(c for c in trainee.get("/api/cards").json() if c["session_id"] == lesson.id)
        yield SimpleNamespace(
            client=trainee, headers=trainee_headers, card=card, url=database_url, dds=dds
        )
    client.post(
        f"/api/sessions/{lesson.id}/finish",
        headers=login(client),
        json={"contract_version": 2, "request_id": str(uuid4())},
    )


def dial(case, number: str):
    return case.client.post(
        f"/api/cards/{case.card['id']}/events",
        json=event("call_dial", {"call_id": str(uuid4()), "phone_ext": number}),
        headers=case.headers,
    )


def test_contact_in_list_answers_others_unavailable(phone):
    for number in ("450", "460"):
        response = dial(phone, number)
        assert response.status_code == 200, response.text
    # 401 — руководитель по умолчанию, но у этой ДДС список преподавателя: номера нет.
    for number in ("401", "499"):
        response = dial(phone, number)
        assert response.status_code == 422, response.text
        assert "неизвестный" in response.json()["message"]

    async def calls(db):
        rows = await db.scalars(select(Call).where(Call.card_id == UUID(phone.card["id"])))
        return {(row.dialed_ext, row.service_id) for row in rows}

    # Звонок абоненту записывается на свою ДДС участника.
    assert run_db(phone.url, calls) == {("450", phone.dds), ("460", phone.dds)}
