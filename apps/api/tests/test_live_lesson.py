"""TC-12: ход занятия — обрыв ученика, пауза, сообщение ученику (contracts/live-lesson.md)."""

import asyncio
import time
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from app.api import realtime
from app.api.database import create_database_app
from app.core.db import Database
from app.core.models import Assignment, Card, Session
from app.worker.scheduler import CardScheduler
from fastapi.testclient import TestClient
from sqlalchemy import select
from starlette.websockets import WebSocketDisconnect

from .test_lifecycle import login, run_db


def users(client: TestClient) -> dict[str, dict]:
    return {item["login"]: item for item in client.get("/api/users").json()}


def running_lesson(client: TestClient, headers, trainees: list[str], delay_s: int = 600) -> str:
    """Идущее занятие: у каждого ученика одна карточка через delay_s от старта."""
    known = users(client)
    scenario = next(
        item for item in client.get("/api/scenarios").json() if item["status"] == "approved"
    )
    body = {
        "title": "Ход занятия TC-12",
        "participants": [
            {
                "user_id": known[name]["id"],
                "workstation_number": 10 + index,
                "dds_service_id": scenario["target_service_id"],
                "level": 1,
            }
            for index, name in enumerate(trainees)
        ],
        "settings_snapshot": client.get("/api/settings").json(),
    }
    created = client.post("/api/sessions", json=body, headers=headers)
    assert created.status_code == 201, created.text
    session_id = created.json()["id"]
    for name in trainees:
        assigned = client.post(
            f"/api/sessions/{session_id}/assignments",
            json={
                "participant_id": known[name]["id"],
                "scenario_id": scenario["id"],
                "order": 1,
                "planned_at": (datetime.now(UTC) + timedelta(seconds=delay_s)).isoformat(),
            },
            headers=headers,
        )
        assert assigned.status_code == 201, assigned.text
    started = client.post(f"/api/sessions/{session_id}/start", headers=headers)
    assert started.status_code == 200, started.text
    return session_id


def finish(client: TestClient, session_id: str) -> None:
    headers = login(client)
    client.post(f"/api/sessions/{session_id}/finish", headers=headers)


def due(database_url: str, session_id: str) -> dict[UUID, datetime]:
    async def read(db):
        rows = await db.scalars(select(Assignment).where(Assignment.session_id == UUID(session_id)))
        return {row.id: row.due_at or row.planned_at for row in rows}

    return run_db(database_url, read)


def backdate_pause(database_url: str, session_id: str, seconds: int) -> None:
    """Пауза началась seconds назад — без ожидания в тесте."""

    async def change(db):
        row = await db.get(Session, UUID(session_id))
        row.paused_at = datetime.now(UTC) - timedelta(seconds=seconds)

    run_db(database_url, change)


def test_silence_limit_is_45_seconds():
    assert realtime.SILENCE_TIMEOUT_S <= 45


def test_silent_trainee_goes_offline_and_late_teacher_sees_who_is_online(database_config):
    app = create_database_app(database_config)
    with TestClient(app) as client:
        app.state.realtime.silence_timeout_s = 1.5
        login(client)
        trainee_id = users(client)["trainee01"]["id"]
        login(client, "trainee01")
        with client.websocket_connect("/ws") as silent:
            assert silent.receive_json()["type"] == "snapshot"
            login(client)
            with client.websocket_connect("/ws") as board:
                assert board.receive_json()["type"] == "snapshot"
                # Доска открыта после ученика — он сразу «в сети».
                event = board.receive_json()
                assert event["type"] == "presence"
                assert event["payload"] == {"user_id": trainee_id, "online": True}
                started = time.monotonic()
                offline = None
                while offline is None and time.monotonic() - started < 10:
                    board.send_json(
                        {"type": "clock.ping", "client_ts": datetime.now(UTC).isoformat()}
                    )
                    while (event := board.receive_json())["type"] != "clock.pong":
                        if event["type"] == "presence" and event["payload"] == {
                            "user_id": trainee_id,
                            "online": False,
                        }:
                            offline = time.monotonic() - started
                    time.sleep(0.2)
                assert offline is not None and offline < 5
            with pytest.raises(WebSocketDisconnect) as closed:
                while True:
                    silent.receive_json()
            assert closed.value.code == 4408


def test_pause_holds_cards_and_resume_shifts_deadlines(database_config, database_url):
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client)
        session_id = running_lesson(client, headers, ["trainee02", "trainee03"])
        trainee02 = users(client)["trainee02"]["id"]
        try:
            paused = client.post(f"/api/sessions/{session_id}/pause", json={}, headers=headers)
            assert paused.status_code == 200, paused.text
            assert paused.json()["paused_at"] is not None
            again = client.post(f"/api/sessions/{session_id}/pause", json={}, headers=headers)
            assert again.status_code == 409
            one = client.post(
                f"/api/sessions/{session_id}/pause",
                json={"participant_id": trainee02},
                headers=headers,
            )
            assert one.status_code == 409

            # На паузе срок наступил, но карточки нет.
            async def overdue(db):
                rows = await db.scalars(
                    select(Assignment).where(Assignment.session_id == UUID(session_id))
                )
                for row in rows:
                    row.due_at = datetime.now(UTC) - timedelta(seconds=1)

            run_db(database_url, overdue)
            before = due(database_url, session_id)
            database = Database(database_url)

            async def tick_and_count():
                try:
                    await CardScheduler(database.sessions, batch_size=100).tick()
                    async with database.sessions() as db:
                        return len(
                            (
                                await db.scalars(
                                    select(Card)
                                    .join(Assignment)
                                    .where(Assignment.session_id == UUID(session_id))
                                )
                            ).all()
                        )
                finally:
                    await database.close()

            assert asyncio.run(tick_and_count()) == 0

            backdate_pause(database_url, session_id, 120)
            resumed = client.post(f"/api/sessions/{session_id}/resume", json={}, headers=headers)
            assert resumed.status_code == 200, resumed.text
            assert resumed.json() == {"paused_at": None, "participants": {}}
            after = due(database_url, session_id)
            for assignment_id, at in before.items():
                shift = (after[assignment_id] - at).total_seconds()
                assert 119 <= shift <= 125, shift
            assert (
                client.post(
                    f"/api/sessions/{session_id}/resume", json={}, headers=headers
                ).status_code
                == 409
            )

            # Пауза одного ученика сдвигает только его срок.
            before = due(database_url, session_id)
            mine = client.post(
                f"/api/sessions/{session_id}/pause",
                json={"participant_id": trainee02},
                headers=headers,
            )
            assert mine.status_code == 200, mine.text
            assert list(mine.json()["participants"]) == [trainee02]

            async def backdate_participant(db):
                lesson = await db.get(Session, UUID(session_id))
                await db.refresh(lesson, ["participants"])
                for item in lesson.participants:
                    if str(item.user_id) == trainee02:
                        item.paused_at = datetime.now(UTC) - timedelta(seconds=60)

            run_db(database_url, backdate_participant)
            resumed = client.post(
                f"/api/sessions/{session_id}/resume",
                json={"participant_id": trainee02},
                headers=headers,
            )
            assert resumed.status_code == 200, resumed.text
            after = due(database_url, session_id)

            async def owners(db):
                rows = await db.scalars(
                    select(Assignment).where(Assignment.session_id == UUID(session_id))
                )
                lesson = await db.get(Session, UUID(session_id))
                await db.refresh(lesson, ["participants"])
                by_participant = {item.id: str(item.user_id) for item in lesson.participants}
                return {row.id: by_participant[row.participant_id] for row in rows}

            owner = run_db(database_url, owners)
            for assignment_id, at in before.items():
                shift = (after[assignment_id] - at).total_seconds()
                if owner[assignment_id] == trainee02:
                    assert 59 <= shift <= 65, shift
                else:
                    assert shift == 0
        finally:
            finish(client, session_id)


def test_pause_is_only_for_owner_of_running_lesson(database_config):
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client)
        session_id = running_lesson(client, headers, ["trainee04"])
        try:
            trainee = login(client, "trainee04")
            assert (
                client.post(
                    f"/api/sessions/{session_id}/pause", json={}, headers=trainee
                ).status_code
                == 403
            )
            headers = login(client)
            stranger = users(client)["trainee05"]["id"]
            assert (
                client.post(
                    f"/api/sessions/{session_id}/pause",
                    json={"participant_id": stranger},
                    headers=headers,
                ).status_code
                == 422
            )
        finally:
            finish(client, session_id)
        headers = login(client)
        assert (
            client.post(f"/api/sessions/{session_id}/pause", json={}, headers=headers).status_code
            == 409
        )


def test_message_reaches_trainee_and_is_marked_read(database_config):
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client)
        session_id = running_lesson(client, headers, ["trainee05"])
        trainee_id = users(client)["trainee05"]["id"]
        try:
            empty = client.post(
                f"/api/sessions/{session_id}/messages",
                json={"user_id": trainee_id, "text": "   "},
                headers=headers,
            )
            assert empty.status_code == 422
            sent = client.post(
                f"/api/sessions/{session_id}/messages",
                json={"user_id": trainee_id, "text": " Откройте карточку 2 "},
                headers=headers,
            )
            assert sent.status_code == 201, sent.text
            message = sent.json()
            assert message["text"] == "Откройте карточку 2" and message["read_at"] is None

            other = login(client, "trainee04")
            assert client.get("/api/messages").json() == []
            assert (
                client.post(f"/api/messages/{message['id']}/read", headers=other).status_code == 404
            )

            own = login(client, "trainee05")
            assert [item["id"] for item in client.get("/api/messages").json()] == [message["id"]]
            read = client.post(f"/api/messages/{message['id']}/read", headers=own)
            assert read.status_code == 200, read.text
            first = read.json()["read_at"]
            assert first is not None
            again = client.post(f"/api/messages/{message['id']}/read", headers=own)
            assert again.json()["read_at"] == first

            login(client)
            live = client.get(f"/api/sessions/{session_id}/live").json()
            assert [(item["id"], item["read_at"]) for item in live["messages"]] == [
                (message["id"], first)
            ]
        finally:
            finish(client, session_id)
