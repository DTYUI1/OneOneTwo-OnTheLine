"""Доклад службе голосом и вариантами (DT-05): виды доклада приходят в отбое и видны в оценке."""

from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from app.api.database import create_database_app
from app.core.models import Brigade, Call, Evaluation
from fastapi.testclient import TestClient
from sqlalchemy import select

from . import test_c03_sessions as c03
from .test_c04_training import event
from .test_lifecycle import login, run_db

lesson = c03.lesson


@pytest.fixture
def case(lesson, database_config, database_url):
    c03.batch(lesson, [c03.item(lesson), c03.item(lesson, participant=1)])
    c03.start(lesson)
    c03.tick(database_url)
    with TestClient(create_database_app(database_config)) as trainee:
        headers = login(trainee, "trainee01")
        card = next(c for c in trainee.get("/api/cards").json() if c["session_id"] == lesson.id)
        result = SimpleNamespace(client=trainee, headers=headers, card=card, url=database_url)
        send(result, "deliver", {})
        send(result, "status_change", {"state": "accepted", "comment": "Принята"})
        yield result


def post(case, kind, payload):
    return case.client.post(
        f"/api/cards/{case.card['id']}/events", json=event(kind, payload), headers=case.headers
    )


def send(case, kind, payload):
    response = post(case, kind, payload)
    assert response.status_code == 200, response.text


def call_service(case, choices, **extra):
    """Звонок в службу карточки: ответ, доклад (виды и как сказаны), отбой."""
    phone = case.card["source"]["service_ids"][0]
    call_id = str(uuid4())
    send(case, "call_dial", {"call_id": call_id, "phone_ext": phone})
    send(case, "call_answer", {"call_id": call_id})
    send(case, "call_hangup", {"call_id": call_id, "report_choices": choices, **extra})
    return call_id


def call_evidence(case):
    send(case, "status_change", {"state": "completed", "comment": "Доложено службе"})

    async def load(db):
        return await db.scalar(
            select(Evaluation).where(Evaluation.card_id == UUID(case.card["id"]))
        )

    evaluation = run_db(case.url, load)
    assert evaluation is not None
    return evaluation.explanation["call"]["evidence"]


def test_report_choices_are_stored_with_hangup(case):
    call_id = call_service(case, ["no_address", "full"])

    events = case.client.get(f"/api/cards/{case.card['id']}/events").json()
    hangup = next(e for e in events if e["type"] == "call_hangup")
    assert hangup["payload"] == {"call_id": call_id, "report_choices": ["no_address", "full"]}
    assert case.client.get(f"/api/calls/{call_id}").json()["state"] == "ended"


def test_incomplete_report_is_a_remark_in_evaluation(case):
    call_service(case, ["no_victims"])

    evidence = call_evidence(case)

    assert any(
        "полного доклада нет — без сведений о пострадавших и силах" in line for line in evidence
    )


def test_report_with_extra_details_is_accepted_and_noted(case):
    call_service(case, ["extra", "full"])

    evidence = call_evidence(case)

    assert any(
        "полный, ответ вариантом, после уточнения; сначала — с лишними сведениями" in line
        for line in evidence
    )


def test_voice_and_choice_modes_are_stored_and_noted(case):
    call_id = call_service(
        case, ["no_address", "full"], report_modes=["voice", "option"], voice_failures=2
    )

    events = case.client.get(f"/api/cards/{case.card['id']}/events").json()
    hangup = next(e for e in events if e["type"] == "call_hangup")
    assert hangup["payload"]["report_modes"] == ["voice", "option"]
    assert hangup["payload"]["voice_failures"] == 2
    evidence = call_evidence(case)
    assert any(
        "полный, ответ вариантом" in line and "предложены варианты ответа" in line
        for line in evidence
    )
    assert call_id


def test_memo_parts_are_stored_and_shown_in_evaluation(case):
    """DT-11: части памятки ДДС, с. 32, — в отбое и в разборе; старые виды тоже читаются."""
    call_id = call_service(
        case,
        ["no_who", "full"],
        report_modes=["voice", "voice"],
        report_parts=[["address", "change"], ["who", "address", "card", "change"]],
    )

    events = case.client.get(f"/api/cards/{case.card['id']}/events").json()
    hangup = next(e for e in events if e["type"] == "call_hangup")
    assert hangup["payload"]["report_parts"][0] == ["address", "change"]
    evidence = call_evidence(case)
    assert any("сначала — не представился" in line for line in evidence)
    assert any(line.endswith("кто вы ✗, адрес и повод ✓, что изменилось ✓") for line in evidence)
    assert call_id


def test_unknown_report_choice_is_rejected(case):
    phone = case.card["source"]["service_ids"][0]
    call_id = str(uuid4())
    send(case, "call_dial", {"call_id": call_id, "phone_ext": phone})
    response = post(case, "call_hangup", {"call_id": call_id, "report_choices": ["голосом"]})
    assert response.status_code == 422
    response = post(
        case,
        "call_hangup",
        {"call_id": call_id, "report_choices": ["full"], "report_modes": ["шёпотом"]},
    )
    assert response.status_code == 422
    response = post(
        case,
        "call_hangup",
        {"call_id": call_id, "report_choices": ["full"], "report_parts": [["приветствие"]]},
    )
    assert response.status_code == 422


def test_system_112_is_in_directory_dialable_and_has_no_brigades(case):
    """GP-04: в справочнике связи есть Система-112 — туда звонят об изменении обстановки
    и за скорой; бригад у неё нет, это не служба ДДС."""
    services = {item["id"]: item for item in case.client.get("/api/services").json()}
    assert services["112"]["phone_ext"] == "112"
    assert services["112"]["category"] == "system112"
    call_id = str(uuid4())
    send(case, "call_dial", {"call_id": call_id, "phone_ext": "112"})

    async def load(db):
        call = await db.get(Call, UUID(call_id))
        brigades = list(await db.scalars(select(Brigade.service_id)))
        return call.service_id, brigades

    service_id, brigades = run_db(case.url, load)
    assert service_id == "112"
    assert "101" in brigades
    assert "112" not in brigades
