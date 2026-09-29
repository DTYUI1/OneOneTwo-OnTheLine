"""C-04: изоляция, ожидание finish, обновления WS и защита версий контента."""

import asyncio
import copy
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from app.api.sessions.lifecycle import finish
from app.api.training.audio import register_asset
from app.api.training.content import store_plan
from app.core.contracts import validate_json
from app.core.db import Database
from app.core.models import Brigade, CallTarget, MessageDelivery, ScenarioTrainingPlan, User
from app.worker.training import TrainingScheduler
from fastapi import HTTPException
from sqlalchemy import func, select

from . import test_c03_sessions as c03
from . import test_c04_training as c04
from .test_c04_training import playback, select_and_dial, send, training
from .test_lifecycle import login, run_db

lesson = c03.lesson
training_case = c04.training_case


@pytest.mark.parametrize("entity", ["brigade", "target"])
def test_inactive_catalog_entries_cannot_be_used(training_case, entity):
    case = training_case
    send(case, "brigades_select", {"brigade_ids": [case.brigade["id"]]})
    model, row_id = (
        (Brigade, case.brigade["id"]) if entity == "brigade" else (CallTarget, case.target["id"])
    )

    async def active(db, value):
        row = await db.get(model, UUID(row_id))
        row.is_active = value

    run_db(case.url, lambda db: active(db, False))
    try:
        send(
            case,
            "call_dial_target",
            {
                "call_id": str(uuid4()),
                "call_target_id": case.target["id"],
                "brigade_id": case.brigade["id"],
            },
            expected=422,
        )
        if entity == "brigade":
            send(case, "brigades_select", {"brigade_ids": [case.brigade["id"]]}, expected=422)
    finally:
        run_db(case.url, lambda db: active(db, True))


def test_foreign_delivery_and_call_are_not_visible(training_case):
    case = training_case
    call_id = select_and_dial(case)
    delivery = training(case)["messages"][0]["delivery"]
    own_card = case.card
    case.headers = login(case.client, "trainee02")
    case.card = next(
        c for c in case.client.get("/api/cards").json() if c["session_id"] == case.lesson.id
    )
    try:
        send(case, "message_presented", playback(delivery), expected=404)
        send(case, "call_answer", {"call_id": call_id}, expected=404)
        url = f"/api/cards/{case.card['id']}/messages/{delivery['delivery_id']}/audio?version=1"
        assert case.client.get(url).status_code == 404
    finally:
        case.card = own_card
        case.headers = login(case.client, "trainee01")
    for name in ["teacher", "admin"]:
        case.headers = login(case.client, name)
        send(case, "message_presented", playback(delivery), expected=403)


def test_training_updated_ws_and_reconnect_do_not_leak_plan(training_case):
    case = training_case
    with case.client.websocket_connect("/ws", headers={"origin": "http://testserver"}) as socket:
        snapshot = socket.receive_json()
        assert snapshot["type"] == "snapshot"
        assert "СЕКРЕТ" not in str(snapshot)
        assert "training_plan" not in str(snapshot)
        send(case, "brigades_select", {"brigade_ids": [case.brigade["id"]]})
        while True:
            message = socket.receive_json()
            if message["type"] == "training.updated":
                validate_json(message, "urn:openapi#/components/schemas/WsServerEvent")
                assert message["payload"] == {
                    "card_id": case.card["id"],
                    "revision": training(case)["revision"],
                }
                break
    select_and_dial(case)
    before = training(case)
    with case.client.websocket_connect("/ws", headers={"origin": "http://testserver"}) as socket:
        assert socket.receive_json()["type"] == "snapshot"
        assert training(case) == before


@pytest.mark.parametrize("training_case", [10], indirect=True)
def test_hangup_and_finish_prevent_future_delivery(training_case):
    case = training_case
    call_id = select_and_dial(case)
    send(case, "call_hangup", {"call_id": call_id})

    async def check():
        database = Database(case.url)
        try:
            # После трубки бригада с готовым докладом перезванивает сама (27.09): это
            # входящий вызов, а не выдача — без ответа диспетчера доклад не выдаётся.
            assert (
                await TrainingScheduler(database.sessions).tick(
                    datetime.now(UTC) + timedelta(days=1)
                )
                == 1
            )
            async with database.sessions() as db:
                assert (
                    await db.scalar(
                        select(func.count())
                        .select_from(MessageDelivery)
                        .where(MessageDelivery.card_id == UUID(case.card["id"]))
                    )
                    == 0
                )
        finally:
            await database.close()

    asyncio.run(check())
    select_and_dial(case)

    async def race():
        database = Database(case.url)
        try:

            async def stop():
                async with database.sessions.begin() as db:
                    teacher = await db.scalar(select(User).where(User.login == "teacher"))
                    await finish(
                        SimpleNamespace(state=SimpleNamespace(db=db, user=teacher)),
                        UUID(case.lesson.id),
                        uuid4(),
                    )

            await asyncio.wait_for(
                asyncio.gather(stop(), TrainingScheduler(database.sessions).tick()), 10
            )
            assert (
                await TrainingScheduler(database.sessions).tick(
                    datetime.now(UTC) + timedelta(days=1)
                )
                == 0
            )
            async with database.sessions() as db:
                assert (
                    await db.scalar(
                        select(func.count())
                        .select_from(MessageDelivery)
                        .where(MessageDelivery.card_id == UUID(case.card["id"]))
                    )
                    == 0
                )
        finally:
            await database.close()

    asyncio.run(race())
    assert training(case)["messages"] == []


def test_plan_and_audio_versions_cannot_be_replaced(training_case):
    case = training_case

    async def verify(db):
        teacher = await db.scalar(select(User).where(User.login == "teacher"))
        scenario_id = UUID(case.lesson.scenarios[0]["id"])
        old = await db.get(ScenarioTrainingPlan, (scenario_id, 1))
        assert await store_plan(db, scenario_id, 1, teacher.id, case.plan) is old
        changed = copy.deepcopy(case.plan)
        changed["messages"][0]["expected_comment"] = "Изменённый эталон"
        with pytest.raises(HTTPException) as error:
            await store_plan(db, scenario_id, 1, teacher.id, changed)
        assert error.value.status_code == 409
        with pytest.raises(HTTPException) as error:
            await store_plan(db, scenario_id, 2, teacher.id, case.plan)
        assert error.value.status_code == 409
        student = await db.scalar(select(User).where(User.login == "trainee01"))
        with pytest.raises(HTTPException) as error:
            await store_plan(db, scenario_id, 1, student.id, case.plan)
        assert error.value.status_code == 403
        audio = case.plan["messages"][1]["message"]["audio"]
        with pytest.raises(HTTPException) as error:
            await register_asset(
                db,
                case.directory,
                asset_id=UUID(audio["asset_id"]),
                version=1,
                relative_path="message.wav",
                duration_ms=101,
                media_type="audio/wav",
            )
        assert error.value.status_code == 409
        with pytest.raises(HTTPException) as error:
            await register_asset(
                db,
                case.directory,
                asset_id=uuid4(),
                version=1,
                relative_path="../outside.wav",
                duration_ms=100,
                media_type="audio/wav",
            )
        assert error.value.status_code == 422

    run_db(case.url, verify)
