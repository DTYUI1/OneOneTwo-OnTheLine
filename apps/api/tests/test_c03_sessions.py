"""C-03: реальные HTTP-транзакции и конкуренция на отдельной PostgreSQL БД."""

import asyncio
import copy
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from app.api.database import create_database_app
from app.api.sessions.lifecycle import finish
from app.core.contracts import validate_json
from app.core.db import Database
from app.core.models import (
    Assignment,
    AssignmentBatch,
    Call,
    Card,
    Job,
    Prediction,
    Scenario,
    Session,
    User,
)
from app.worker.runtime import Worker
from app.worker.scheduler import CardScheduler
from fastapi.testclient import TestClient
from sqlalchemy import event as sqlalchemy_event
from sqlalchemy import func, select

from .test_lifecycle import event, login, run_db


@pytest.fixture
def lesson(database_client, database_url):
    client = database_client
    headers = login(client)
    users = {u["login"]: u for u in client.get("/api/users").json()}
    template = next(s for s in client.get("/api/scenarios").json() if s["status"] == "approved")
    scenarios = []
    for _ in range(2):
        body = copy.deepcopy(template)
        body["id"] = str(uuid4())
        response = client.post("/api/scenarios", json=body, headers=headers)
        assert response.status_code == 201, response.text
        scenarios.append(response.json())
    participants = [
        {
            "user_id": users[f"trainee0{i + 1}"]["id"],
            "workstation_number": i + 1,
            "dds_service_id": s["target_service_id"],
            "level": 2,
        }
        for i, s in enumerate(scenarios)
    ]
    settings = {**client.get("/api/settings").json(), "parallel_cards": 2}
    response = client.post(
        "/api/sessions",
        headers=headers,
        json={
            "title": "Проверка C-03",
            "participants": participants,
            "settings_snapshot": settings,
        },
    )
    assert response.status_code == 201, response.text
    result = SimpleNamespace(
        client=client,
        headers=headers,
        id=response.json()["id"],
        participants=participants,
        scenarios=scenarios,
    )
    yield result

    async def restore_scenarios(db):
        for original in scenarios:
            scenario = await db.get(Scenario, UUID(original["id"]))
            for field in ["reference", "status", "version", "target_service_id"]:
                setattr(scenario, field, original[field])

    run_db(database_url, restore_scenarios)
    client.post(
        f"/api/sessions/{result.id}/finish",
        headers=login(client),
        json={"contract_version": 2, "request_id": str(uuid4())},
    )


def item(lesson, participant=0, order=1, delay=0):
    scenario = lesson.scenarios[participant]
    return {
        "participant_id": lesson.participants[participant]["user_id"],
        "scenario_id": scenario["id"],
        "scenario_version": scenario["version"],
        "order": order,
        "delay_from_start_s": delay,
        "delivery_mode": "profile",
    }


def batch(lesson, items):
    body = {"request_id": str(uuid4()), "items": items}
    response = lesson.client.post(
        f"/api/sessions/{lesson.id}/assignments/batch", json=body, headers=lesson.headers
    )
    assert response.status_code == 201, response.text
    validate_json(response.json(), "urn:openapi#/components/schemas/AssignmentBatch")
    return body, response.json()


def start(lesson):
    response = lesson.client.post(f"/api/sessions/{lesson.id}/start", headers=lesson.headers)
    assert response.status_code == 200, response.text


def tick(url, now=None, workers=1, limit=23):
    async def run():
        database = Database(url)
        try:
            return sum(
                await asyncio.gather(
                    *[
                        CardScheduler(database.sessions, batch_size=limit).tick(now)
                        for _ in range(workers)
                    ]
                )
            )
        finally:
            await database.close()

    return asyncio.run(run())


def lifecycle(lesson):
    response = lesson.client.get(f"/api/sessions/{lesson.id}/lifecycle")
    assert response.status_code == 200, response.text
    validate_json(response.json(), "urn:openapi#/components/schemas/SessionLifecycle")
    return response.json()


@pytest.mark.parametrize(
    "defect,expected",
    [
        ("participant", 422),
        ("scenario", 422),
        ("version", 409),
        ("profile", 422),
        ("duplicate_order", 409),
        ("decreasing_order", 409),
        ("decreasing_delay", 422),
        ("unapproved", 422),
        ("unevaluable", 422),
    ],
)
def test_batch_rolls_back_all_items(lesson, database_url, defect, expected):
    items = [item(lesson, order=2, delay=20), item(lesson, order=3, delay=30)]
    if defect == "participant":
        items[1]["participant_id"] = str(uuid4())
    elif defect == "scenario":
        items[1]["scenario_id"] = str(uuid4())
    elif defect == "version":
        items[1]["scenario_version"] += 1
    elif defect == "profile":

        async def mismatch(db):
            scenario = await db.get(Scenario, UUID(items[1]["scenario_id"]))
            scenario.target_service_id = "103" if scenario.target_service_id != "103" else "102"

        run_db(database_url, mismatch)
    elif defect == "duplicate_order":
        items[1]["order"] = 2
    elif defect == "decreasing_order":
        items[1]["order"] = 1
    elif defect == "decreasing_delay":
        items[1]["delay_from_start_s"] = 19
    else:

        async def invalidate(db):
            scenario = await db.get(Scenario, UUID(items[1]["scenario_id"]))
            if defect == "unapproved":
                scenario.status = "retired"
            else:
                scenario.reference = {}

        run_db(database_url, invalidate)
    body = {"request_id": str(uuid4()), "items": items}
    response = lesson.client.post(
        f"/api/sessions/{lesson.id}/assignments/batch", headers=lesson.headers, json=body
    )
    assert response.status_code == expected, response.text

    async def counts(db):
        for model in [Assignment, AssignmentBatch]:
            assert (
                await db.scalar(
                    select(func.count())
                    .select_from(model)
                    .where(model.session_id == UUID(lesson.id))
                )
                == 0
            )

    run_db(database_url, counts)


def test_retry_receipt_survives_start_finish_and_restart(lesson, database_config):
    body, receipt = batch(lesson, [item(lesson), item(lesson, participant=1)])
    path = f"/api/sessions/{lesson.id}/assignments/batch"
    start(lesson)
    finish_body = {"contract_version": 2, "request_id": str(uuid4())}
    for _ in range(2):
        response = lesson.client.post(
            f"/api/sessions/{lesson.id}/finish", json=finish_body, headers=lesson.headers
        )
        assert response.status_code == 200, response.text
    with TestClient(create_database_app(database_config)) as restarted:
        headers = login(restarted)
        response = restarted.post(path, json=body, headers=headers)
        assert response.status_code == 201 and response.json() == receipt
        changed = {**body, "items": list(reversed(body["items"]))}
        assert restarted.post(path, json=changed, headers=headers).status_code == 409
        assert restarted.get(f"/api/sessions/{lesson.id}/assignment-batches").json() == [receipt]
        assert (
            len(
                restarted.get(f"/api/sessions/{lesson.id}/lifecycle").json()[
                    "cancelled_assignment_ids"
                ]
            )
            == 2
        )


def test_concurrent_batch_retries_and_conflicts(lesson, database_config, database_url):
    body = {"request_id": str(uuid4()), "items": [item(lesson), item(lesson, participant=1)]}
    path = f"/api/sessions/{lesson.id}/assignments/batch"
    with TestClient(create_database_app(database_config)) as other:
        headers = login(other)
        with ThreadPoolExecutor(2) as pool:
            a = pool.submit(lesson.client.post, path, json=body, headers=lesson.headers)
            b = pool.submit(other.post, path, json=body, headers=headers)
            first, second = a.result(timeout=10), b.result(timeout=10)
        assert first.status_code == second.status_code == 201
        assert first.json() == second.json()
        changed = {**body, "items": [{**body["items"][0], "delay_from_start_s": 1}]}
        assert other.post(path, json=changed, headers=headers).status_code == 409

    async def verify(db):
        assert (
            await db.scalar(
                select(func.count())
                .select_from(Assignment)
                .where(Assignment.session_id == UUID(lesson.id))
            )
            == 2
        )

    run_db(database_url, verify)


def test_scheduler_delay_order_capacity_and_restart(lesson, database_url):
    _, receipt = batch(
        lesson,
        [item(lesson, order=i, delay=30) for i in range(1, 5)] + [item(lesson, participant=1)],
    )
    assert tick(database_url) == 0
    start(lesson)
    started = datetime.fromisoformat(lifecycle(lesson)["started_at"])
    assert tick(database_url, started + timedelta(seconds=29), workers=2, limit=1) == 1
    assert tick(database_url, started + timedelta(seconds=30), workers=2, limit=1) in (1, 2)
    tick(database_url, started + timedelta(seconds=31), workers=2, limit=1)

    async def verify(db):
        assignments = list(
            (
                await db.scalars(
                    select(Assignment)
                    .where(Assignment.session_id == UUID(lesson.id))
                    .order_by(Assignment.order)
                )
            ).all()
        )
        for a in assignments:
            assert a.planned_at is None
            assert a.due_at == started + timedelta(seconds=a.delay_from_start_s)
        cards = list(
            (
                await db.scalars(
                    select(Card).join(Assignment).where(Assignment.session_id == UUID(lesson.id))
                )
            ).all()
        )
        expected = {UUID(receipt["assignments"][i]["id"]) for i in [0, 1, 4]}
        assert {c.assignment_id for c in cards} == expected
        assert (
            await db.scalar(
                select(func.count())
                .select_from(Prediction)
                .where(Prediction.card_id.in_([c.id for c in cards]))
            )
            == 3
        )

    run_db(database_url, verify)
    assert tick(database_url, started + timedelta(hours=1), workers=2) == 0


def test_finish_preserves_attempts_calls_evidence_and_late_audio(
    lesson,
    database_config,
    database_url,
    tmp_path,
):
    _, receipt = batch(
        lesson,
        [
            item(lesson),
            item(lesson, order=2),
            item(lesson, order=3, delay=3600),
            item(lesson, participant=1),
        ],
    )
    start(lesson)
    tick(database_url)
    config = database_config.model_copy(update={"audio_dir": tmp_path})
    with TestClient(create_database_app(config)) as trainee:
        headers = login(trainee, "trainee01")
        cards = [c for c in trainee.get("/api/cards").json() if c["session_id"] == lesson.id]
        completed, interrupted = cards

        def send(card, body):
            response = trainee.post(f"/api/cards/{card['id']}/events", json=body, headers=headers)
            assert response.status_code == 200, response.text
            return response.json()

        delivered_body = event("deliver", {})
        old_receipt = send(completed, delivered_body)
        send(completed, event("status_change", {"state": "accepted", "comment": "Принято"}))
        send(completed, event("status_change", {"state": "refused", "comment": "Отказ"}))
        send(interrupted, event("deliver", {}))
        send(interrupted, event("open", {}))
        send(interrupted, event("field_change", {"field": "service_number", "value": "C03"}))
        call_id = str(uuid4())
        send(interrupted, event("call_dial", {"call_id": call_id, "phone_ext": "102"}))
        send(interrupted, event("call_answer", {"call_id": call_id}))
        before_card = trainee.get(f"/api/cards/{interrupted['id']}").json()
        before_events = trainee.get(f"/api/cards/{interrupted['id']}/events").json()
        # Закрыта одна карточка из трёх выданных, четвёртое назначение ещё не выдано.
        assert lifecycle(lesson)["remaining_assignments"] == 3
        assert before_card["interrupted_at"] is None
        body = {"contract_version": 2, "request_id": str(uuid4())}
        response = lesson.client.post(
            f"/api/sessions/{lesson.id}/finish", json=body, headers=lesson.headers
        )
        assert response.status_code == 200, response.text
        snapshot = lifecycle(lesson)
        assert sorted(a["status"] for a in snapshot["attempts"]) == [
            "completed",
            "interrupted",
            "interrupted",
        ]
        assert snapshot["cancelled_assignment_ids"] == [receipt["assignments"][2]["id"]]
        assert snapshot["remaining_assignments"] == 0
        attempt = next(a for a in snapshot["attempts"] if a["card_id"] == interrupted["id"])
        assert attempt["recording_status"] == "upload_pending"
        assert attempt["active_call_id"] is None
        assert attempt["interrupted_at"] == snapshot["finished_at"]
        # Карточка не меняется, кроме отметки прерывания: по ней АРМ останавливает таймеры.
        after_card = trainee.get(f"/api/cards/{interrupted['id']}").json()
        assert after_card["interrupted_at"] is not None
        assert after_card == {**before_card, "interrupted_at": after_card["interrupted_at"]}
        assert trainee.get(f"/api/cards/{completed['id']}").json()["interrupted_at"] is None
        assert trainee.get(f"/api/cards/{interrupted['id']}/events").json() == before_events
        assert trainee.get(f"/api/calls/{call_id}").json()["state"] == "ended"
        repeated = send(completed, delivered_body)
        assert repeated == {**old_receipt, "duplicate": True}
        for kind, payload in [
            ("deliver", {}),
            ("open", {}),
            ("comment", {"comment": "Поздно"}),
            ("call_hangup", {"call_id": call_id}),
        ]:
            rejected = trainee.post(
                f"/api/cards/{interrupted['id']}/events", json=event(kind, payload), headers=headers
            )
            assert rejected.status_code == 409
            assert rejected.json()["code"] == "session_finished"
        audio = b"RIFF-c03-preserved-audio"
        uploaded = trainee.post(
            f"/api/calls/{call_id}/audio",
            headers=headers,
            files={"audio": ("report.wav", audio, "audio/wav")},
        )
        assert uploaded.status_code == 200, uploaded.text
        assert trainee.get(uploaded.json()["audio_url"]).content == audio
        assert (
            next(a for a in lifecycle(lesson)["attempts"] if a["card_id"] == interrupted["id"])[
                "recording_status"
            ]
            == "saved"
        )
        own = trainee.get(f"/api/sessions/{lesson.id}/lifecycle").json()
        assert len(own["attempts"]) == 2
        assert all(
            a["participant_id"] == lesson.participants[0]["user_id"] for a in own["attempts"]
        )
        other_headers = login(trainee, "trainee02")
        assert trainee.get(f"/api/calls/{call_id}/audio").status_code == 404
        assert (
            trainee.post(
                f"/api/calls/{call_id}/audio",
                headers=other_headers,
                files={"audio": ("report.wav", audio, "audio/wav")},
            ).status_code
            == 404
        )
    assert tick(database_url, datetime.now(UTC) + timedelta(days=1), workers=2) == 0

    async def verify(db):
        call = await db.get(Call, UUID(call_id))
        assert call.end_reason == "session_finished"
        unfinished = [
            UUID(a["card_id"]) for a in snapshot["attempts"] if a["status"] == "interrupted"
        ]
        forecasts = await db.scalars(select(Prediction).where(Prediction.card_id.in_(unfinished)))
        assert all(p.actual_score is None and p.actual_time_s is None for p in forecasts)
        jobs = list((await db.scalars(select(Job).where(Job.kind == "evaluate"))).all())
        assert any(j.payload["card_id"] == completed["id"] for j in jobs)
        assert not any(j.payload["card_id"] in {str(c) for c in unfinished} for j in jobs)
        worker = Worker(config)
        try:
            pending = next(j for j in jobs if j.payload["card_id"] == completed["id"])
            result = await worker.handlers.handle_evaluate(db, pending.payload)
            assert result["evaluation_id"] == pending.payload["evaluation_id"]
        finally:
            await worker.close()

    run_db(database_url, verify)
    with TestClient(create_database_app(config)) as restarted:
        login(restarted, "trainee01")
        assert restarted.get(f"/api/calls/{call_id}/audio").content == audio
        assert restarted.get(f"/api/cards/{interrupted['id']}/events").json() == before_events


def test_draft_finish_is_idempotent_and_cancels_without_cards(lesson, database_url):
    batch(lesson, [item(lesson)])
    body = {"contract_version": 2, "request_id": str(uuid4())}
    path = f"/api/sessions/{lesson.id}/finish"
    first = lesson.client.post(path, json=body, headers=lesson.headers)
    assert first.status_code == 200
    before = lifecycle(lesson)
    for request_id in [body["request_id"], str(uuid4())]:
        response = lesson.client.post(
            path, json={**body, "request_id": request_id}, headers=lesson.headers
        )
        assert response.json() == first.json()
        assert lifecycle(lesson) == before
    assert before["started_at"] is None and before["attempts"] == []
    assert len(before["cancelled_assignment_ids"]) == 1
    assert tick(database_url) == 0


@pytest.mark.parametrize("defect", ["version", "status", "reference"])
def test_start_revalidates_every_scenario(lesson, database_url, defect):
    batch(lesson, [item(lesson), item(lesson, participant=1)])

    async def damage(db):
        scenario = await db.get(Scenario, UUID(lesson.scenarios[1]["id"]))
        if defect == "version":
            scenario.version += 1
        elif defect == "status":
            scenario.status = "retired"
        else:
            scenario.reference = {}

    run_db(database_url, damage)
    response = lesson.client.post(f"/api/sessions/{lesson.id}/start", headers=lesson.headers)
    assert response.status_code == (409 if defect == "version" else 422), response.text
    assert lifecycle(lesson)["status"] == "draft"
    assert tick(database_url) == 0


def test_finish_races_workers_without_late_cards(lesson, database_url):
    batch(lesson, [item(lesson, order=i) for i in range(1, 5)] + [item(lesson, participant=1)])
    start(lesson)

    async def race():
        database = Database(database_url)
        try:

            async def stop():
                async with database.sessions.begin() as db:
                    teacher = await db.scalar(select(User).where(User.login == "teacher"))
                    request = SimpleNamespace(state=SimpleNamespace(db=db, user=teacher))
                    await finish(request, UUID(lesson.id), uuid4())

            await asyncio.wait_for(
                asyncio.gather(
                    CardScheduler(database.sessions, batch_size=1).tick(),
                    stop(),
                    CardScheduler(database.sessions, batch_size=1).tick(),
                ),
                timeout=10,
            )
            assert await CardScheduler(database.sessions).tick() == 0
            async with database.sessions() as db:
                session = await db.get(Session, UUID(lesson.id))
                cards = list(
                    (
                        await db.scalars(
                            select(Card).join(Assignment).where(Assignment.session_id == session.id)
                        )
                    ).all()
                )
                assert all(
                    c.appeared_at <= session.finished_at and c.interrupted_at == session.finished_at
                    for c in cards
                )
        finally:
            await database.close()

    asyncio.run(race())


def test_event_waiting_on_finish_rechecks_session(lesson, database_config, database_url):
    batch(lesson, [item(lesson), item(lesson, participant=1)])
    start(lesson)
    tick(database_url)
    with TestClient(create_database_app(database_config)) as trainee:
        headers = login(trainee, "trainee01")
        card = next(c for c in trainee.get("/api/cards").json() if c["session_id"] == lesson.id)
        reached_lock = threading.Event()

        def observe_lock(conn, cursor, statement, parameters, context, executemany):
            if "FROM sessions" in statement and "FOR UPDATE" in statement:
                reached_lock.set()

        engine = trainee.app.state.database.engine.sync_engine
        sqlalchemy_event.listen(engine, "before_cursor_execute", observe_lock)
        try:

            async def run():
                database = Database(database_url)
                try:
                    with ThreadPoolExecutor(1) as pool:
                        async with database.sessions.begin() as db:
                            await db.scalar(
                                select(Session)
                                .where(Session.id == UUID(lesson.id))
                                .with_for_update()
                            )
                            future = pool.submit(
                                trainee.post,
                                f"/api/cards/{card['id']}/events",
                                json=event("deliver", {}),
                                headers=headers,
                            )
                            assert await asyncio.to_thread(reached_lock.wait, 5)
                            assert not future.done()
                            teacher = await db.scalar(select(User).where(User.login == "teacher"))
                            request = SimpleNamespace(state=SimpleNamespace(db=db, user=teacher))
                            await finish(request, UUID(lesson.id), uuid4())
                        response = await asyncio.wrap_future(future)
                        assert response.status_code == 409
                        assert response.json()["code"] == "session_finished"
                finally:
                    await database.close()

            asyncio.run(run())
        finally:
            sqlalchemy_event.remove(engine, "before_cursor_execute", observe_lock)
        assert trainee.get(f"/api/cards/{card['id']}").json()["state"] == "added"
        assert trainee.get(f"/api/cards/{card['id']}/events").json() == []
