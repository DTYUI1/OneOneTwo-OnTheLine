"""Дополнение C-01 от 24.09: этапы «Прибытие»/«Проведение работ», возврат и причина отказа."""

import os
import subprocess
import sys
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from app.api.database import create_database_app
from app.core.config import ROOT
from app.core.models import Card, CardEvent, Scenario, Setting, User
from app.seed.loader import seed
from fastapi.testclient import TestClient
from sqlalchemy import MetaData, func, select

from .test_c03_migration import migrate
from .test_c03_sessions import batch, item, lesson, start, tick  # noqa: F401
from .test_lifecycle import event, login, run_db


@pytest.fixture
def trainee_card(lesson, database_config, database_url):  # noqa: F811
    batch(lesson, [item(lesson), item(lesson, participant=1)])
    start(lesson)
    tick(database_url)
    with TestClient(create_database_app(database_config)) as trainee:
        headers = login(trainee, "trainee01")
        card = next(c for c in trainee.get("/api/cards").json() if c["session_id"] == lesson.id)

        def send(kind, payload, expected=200):
            response = trainee.post(
                f"/api/cards/{card['id']}/events", json=event(kind, payload), headers=headers
            )
            assert response.status_code == expected, response.text
            return response.json()

        send("deliver", {})
        send("open", {})
        yield card, send


def status(state, comment="Сведения внесены"):
    return {"state": state, "comment": comment}


def test_full_v3_path_with_return_and_all_stages(trainee_card, database_url):
    card, send = trainee_card
    send("status_change", status("rejected", "Не наша зона: адрес относится к соседнему району"))
    # Памятка, стр. 32: ошибочно выбранную «Не принята» исправляют выбором «Принята».
    send("status_change", status("accepted", "Ошибочно не принята, принимаю"))
    for state in ["responding", "arrived", "working"]:
        assert send("status_change", status(state))["card"]["state"] == state
    send("field_change", {"field": "service_number", "value": "77-02"})
    closed = send("status_change", status("completed", "Работы завершены, пострадавших нет"))
    assert closed["card"]["state"] == "completed"
    assert closed["card"]["closed_at"] is not None
    # Завершающий статус закрывает карточку для редактирования (памятка, стр. 22).
    send("field_change", {"field": "service_number", "value": "поздно"}, expected=409)
    send("comment", {"comment": "поздно"}, expected=409)

    async def verify(db):
        stored = await db.get(Card, UUID(card["id"]))
        assert stored.state == "completed"
        assert stored.current["service_number"] == "77-02"
        states = (
            await db.scalars(
                select(CardEvent.payload["state"].astext)
                .where(CardEvent.card_id == stored.id, CardEvent.type == "status_change")
                .order_by(CardEvent.server_ts, CardEvent.id)
            )
        ).all()
        assert states == [
            "rejected",
            "accepted",
            "responding",
            "arrived",
            "working",
            "completed",
        ]

    run_db(database_url, verify)


@pytest.mark.parametrize(
    "path,backward",
    [
        (["accepted", "arrived"], "responding"),
        (["accepted", "working"], "arrived"),
        (["accepted", "arrived", "working"], "accepted"),
    ],
)
def test_stages_move_forward_only(trainee_card, path, backward):
    _, send = trainee_card
    for state in path:
        send("status_change", status(state))
    send("status_change", status(backward), expected=409)


def test_stages_may_be_skipped_when_scenario_allows(trainee_card):
    _, send = trainee_card
    send("status_change", status("accepted"))
    assert send("status_change", status("completed"))["card"]["state"] == "completed"


@pytest.mark.parametrize("comment", [" ", "\n\t "])
def test_refusal_requires_reason(trainee_card, database_url, comment):
    card, send = trainee_card
    response = send("status_change", status("rejected", comment), expected=422)
    assert response["code"] == "reason_required"
    send("status_change", status("accepted"))
    send("status_change", status("refused", comment), expected=422)

    async def verify(db):
        stored = await db.get(Card, UUID(card["id"]))
        assert stored.state == "accepted"
        # Отклонённое событие не попадает в журнал: сохраняется только принятое.
        count = await db.scalar(
            select(func.count())
            .select_from(CardEvent)
            .where(CardEvent.card_id == stored.id, CardEvent.type == "status_change")
        )
        assert count == 1

    run_db(database_url, verify)
    closed = send("status_change", status("refused", "Бригада не требуется: вызов ложный"))
    assert closed["card"]["state"] == "refused"


def test_downgrade_refuses_to_rewrite_new_stages(migration_database_url):
    url = migration_database_url
    migrate(url, "head")
    now = datetime.now(UTC)
    card_id = uuid4()

    async def prepare(db):
        await seed(db, "test-password", include_training=False)
        teacher = await db.scalar(select(User).where(User.login == "teacher"))
        trainee = await db.scalar(select(User).where(User.login == "trainee01"))
        scenario = await db.scalar(select(Scenario).where(Scenario.status == "approved").limit(1))
        setting = await db.scalar(select(Setting).limit(1))
        metadata = MetaData()
        await (await db.connection()).run_sync(metadata.reflect)
        ids = {name: uuid4() for name in ["sessions", "session_participants", "assignments"]}
        rows = {
            "sessions": dict(
                teacher_id=teacher.id,
                title="Этап «Прибытие»",
                status="finished",
                started_at=now,
                finished_at=now,
                settings_snapshot=setting.value,
            ),
            "session_participants": dict(
                session_id=ids["sessions"],
                user_id=trainee.id,
                workstation_id=1,
                dds_service_id=scenario.target_service_id,
                level=1,
                rating_at_start=0.0,
            ),
            "assignments": dict(
                session_id=ids["sessions"],
                participant_id=ids["session_participants"],
                scenario_id=scenario.id,
                order=1,
                planned_at=now,
                status="delivered",
            ),
        }
        for name, row in rows.items():
            await db.execute(metadata.tables[name].insert().values(id=ids[name], **row))
        await db.execute(
            metadata.tables["cards"]
            .insert()
            .values(
                id=card_id,
                assignment_id=ids["assignments"],
                number="99000006",
                state="arrived",
                appeared_at=now,
                delivered_at=now,
                opened_at=now,
                first_status_at=now,
                closed_at=None,
                current={"service_number": "v3", "comment": "Бригада прибыла"},
                redirected_to_service_id=None,
            )
        )

    run_db(url, prepare)
    refused = subprocess.run(
        [sys.executable, "-m", "alembic", "-c", "apps/api/alembic.ini", "downgrade", "0005"],
        cwd=ROOT,
        env={**os.environ, "DATABASE_URL": url},
        capture_output=True,
        text=True,
    )
    assert refused.returncode != 0
    assert "backup/restore" in refused.stderr

    async def state(db):
        return await db.scalar(select(Card.state).where(Card.id == card_id))

    assert run_db(url, state) == "arrived"
