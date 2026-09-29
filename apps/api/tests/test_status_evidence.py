"""L-01: статус эталона требуется, только если доклад-основание предъявлен обучаемому."""

import asyncio
from datetime import timedelta
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from app.api.database import create_database_app
from app.api.training.content import store_plan
from app.core.db import Database
from app.core.models import Call, Evaluation, Scenario, User
from app.worker.training import TrainingScheduler
from fastapi.testclient import TestClient
from sqlalchemy import select

from . import test_c03_sessions as c03
from .test_c04_training import event, playback
from .test_lifecycle import login, run_db

lesson = c03.lesson

# Доклады: выезд, прибытие, работы, завершение — и статус, который каждый обосновывает.
REPORTS = [
    ("Бригада выехала", "responding", 0),
    ("Бригада прибыла", "arrived", 10),
    ("Приступили к работам", "working", 20),
    ("Работы завершены", "completed", 30),
]
FULL_FLOW = ["received", "accepted", "responding", "arrived", "working", "completed"]


@pytest.fixture
def case(lesson, database_config, database_url):
    scenario = lesson.scenarios[0]
    service_id = scenario["target_service_id"]
    brigade = lesson.client.get(f"/api/services/{service_id}/brigades").json()[0]
    target = next(
        t
        for t in lesson.client.get(f"/api/services/{service_id}/call-targets").json()
        if t["brigade_id"] == brigade["id"]
    )
    plan = {
        "version": 1,
        "required_brigade_ids": [brigade["id"]],
        "messages": [
            {
                "message": {"id": str(uuid4()), "version": 1, "text": text, "audio": None},
                "brigade_id": brigade["id"],
                "call_target_id": target["id"],
                "available_after_s": after_s,
                "expected_comment": text,
                "justifies_state": state,
            }
            for text, state, after_s in REPORTS
        ],
        "observable_defects": [],
    }

    async def prepare(db):
        row = await db.get(Scenario, UUID(scenario["id"]))
        row.reference = {**row.reference, "expected_flow": FULL_FLOW}
        teacher = await db.scalar(select(User).where(User.login == "teacher"))
        await store_plan(db, row.id, row.version, teacher.id, plan)

    run_db(database_url, prepare)
    # Занятие → назначение → выдача карточки.
    c03.batch(lesson, [c03.item(lesson), c03.item(lesson, participant=1)])
    c03.start(lesson)
    c03.tick(database_url)
    with TestClient(create_database_app(database_config)) as trainee:
        headers = login(trainee, "trainee01")
        card = next(c for c in trainee.get("/api/cards").json() if c["session_id"] == lesson.id)
        result = SimpleNamespace(
            client=trainee,
            headers=headers,
            card=card,
            brigade=brigade,
            target=target,
            url=database_url,
        )
        send(result, "deliver", {})
        send(result, "status_change", {"state": "accepted", "comment": "Принята"})
        yield result


def send(case, kind, payload):
    response = case.client.post(
        f"/api/cards/{case.card['id']}/events", json=event(kind, payload), headers=case.headers
    )
    assert response.status_code == 200, response.text


def call_brigade(case):
    send(case, "brigades_select", {"brigade_ids": [case.brigade["id"]]})
    call_id = str(uuid4())
    send(
        case,
        "call_dial_target",
        {"call_id": call_id, "call_target_id": case.target["id"], "brigade_id": case.brigade["id"]},
    )
    send(case, "call_answer", {"call_id": call_id})
    return call_id


def deliver_until(case, call_id, seconds):
    """Выдать доклады, чей срок наступил за `seconds` с ответа бригады."""

    async def answered(db):
        return (await db.get(Call, UUID(call_id))).answered_at

    answered_at = run_db(case.url, answered)

    async def run():
        database = Database(case.url)
        try:
            await TrainingScheduler(database.sessions).tick(
                answered_at + timedelta(seconds=seconds)
            )
        finally:
            await database.close()

    asyncio.run(run())


def present_all(case):
    """Подтвердить прочтение каждого выданного доклада (message_presented)."""
    response = case.client.get(f"/api/cards/{case.card['id']}/training")
    assert response.status_code == 200, response.text
    messages = response.json()["messages"]
    for item in messages:
        send(case, "message_presented", playback(item["delivery"]))
    return [m["delivery"]["message"]["text"] for m in messages]


def set_states(case, states):
    for state in states:
        send(case, "status_change", {"state": state, "comment": "По докладу бригады"})


def status_flow(case):
    async def load(db):
        return await db.scalar(
            select(Evaluation).where(Evaluation.card_id == UUID(case.card["id"]))
        )

    evaluation = run_db(case.url, load)
    assert evaluation is not None
    return evaluation.rules_scores["status_flow"], evaluation.explanation["status_flow"]


def test_all_reports_presented_and_followed_gives_full_score(case):
    call_id = call_brigade(case)
    deliver_until(case, call_id, 30)
    assert len(present_all(case)) == 4
    send(case, "call_hangup", {"call_id": call_id})
    set_states(case, ["responding", "arrived", "working", "completed"])

    score, details = status_flow(case)

    assert score == 1.0
    assert "Не потребовал" not in details["explanation"]


def test_hangup_before_works_reports_blocks_unconfirmed_completion(case):
    call_id = call_brigade(case)
    deliver_until(case, call_id, 10)
    assert present_all(case) == ["Бригада выехала", "Бригада прибыла"]
    send(case, "call_hangup", {"call_id": call_id})
    deliver_until(case, call_id, 40)  # звонок окончен — новые доклады не выдаются
    set_states(case, ["responding", "arrived"])
    response = case.client.post(
        f"/api/cards/{case.card['id']}/events",
        json=event("status_change", {"state": "completed", "comment": "Работы завершены"}),
        headers=case.headers,
    )
    assert response.status_code == 409
    assert response.json()["code"] == "report_required"
    assert case.client.get(f"/api/cards/{case.card['id']}").json()["state"] == "arrived"


def test_presented_report_without_its_status_lowers_score(case):
    call_id = call_brigade(case)
    deliver_until(case, call_id, 30)
    assert len(present_all(case)) == 4
    send(case, "call_hangup", {"call_id": call_id})
    set_states(case, ["responding", "arrived", "completed"])

    score, details = status_flow(case)

    assert score < 1.0
    assert "Не потребовал" not in details["explanation"]
