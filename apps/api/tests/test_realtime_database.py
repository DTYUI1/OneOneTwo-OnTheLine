"""Реальный PostgreSQL: потерянный NOTIFY, новый snapshot и сохранение границ доступа."""

import time
from contextlib import ExitStack
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from app.api.database import create_database_app
from app.api.realtime import RealtimeHub
from app.core.contracts import validate_json
from app.core.models import WorkerHeartbeat
from fastapi.testclient import TestClient
from sqlalchemy import delete, text
from starlette.websockets import WebSocketDisconnect


def wait_until(predicate):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("Не дождались восстановления LISTEN/NOTIFY")


def receive_type(socket, kind):
    while True:
        event = socket.receive_json()
        if event["type"] == kind:
            validate_json(event, "urn:openapi#/components/schemas/WsServerEvent")
            return event["payload"]


def expect_reconnect(socket):
    with pytest.raises(WebSocketDisconnect) as closed:
        while True:
            socket.receive_json()
    assert closed.value.code == 1012


def test_listen_recovery_resnapshots_with_current_permissions(database_config, monkeypatch):
    allow = False
    attempts = 0
    original = RealtimeHub._open_listener

    async def controlled_connect(hub):
        nonlocal attempts
        attempts += 1
        if not allow:
            raise OSError("Имитируем недоступность только LISTEN; HTTP-БД доступна")
        return await original(hub)

    monkeypatch.setattr(RealtimeHub, "_open_listener", controlled_connect)
    app = create_database_app(database_config)
    worker_id = f"realtime-test-{uuid4()}"
    with TestClient(app) as client:
        hub = app.state.realtime

        async def heartbeat(create):
            async with app.state.database.sessions.begin() as db:
                if create:
                    db.add(WorkerHeartbeat(worker_id=worker_id, updated_at=datetime.now(UTC)))
                else:
                    await db.execute(
                        delete(WorkerHeartbeat).where(WorkerHeartbeat.worker_id == worker_id)
                    )

        def login(name):
            assert (
                client.post(
                    "/api/auth/login", json={"login": name, "password": "test-password"}
                ).status_code
                == 200
            )
            return {
                "cookie": "; ".join(f"{key}={value}" for key, value in client.cookies.items()),
                "X-CSRF-Token": client.cookies["csrf"],
            }

        teacher = login("teacher")
        users = {item["login"]: item for item in client.get("/api/users").json()}
        settings = client.get("/api/settings").json()
        scenario = next(
            item for item in client.get("/api/scenarios").json() if item["status"] == "approved"
        )
        trainee = login("trainee01")
        stranger = login("trainee03")
        revoked = login("trainee04")
        client.portal.call(heartbeat, True)

        def create_started_lesson():
            response = client.post(
                "/api/sessions",
                headers=teacher,
                json={
                    "title": f"Восстановление {uuid4()}",
                    "participants": [
                        {
                            "user_id": users[login]["id"],
                            "workstation_number": index,
                            "dds_service_id": "102",
                            "level": 1,
                        }
                        for index, login in enumerate(["trainee01", "trainee02"], 1)
                    ],
                    "settings_snapshot": settings,
                },
            )
            assert response.status_code == 201, response.text
            lesson = response.json()
            for index, participant in enumerate(lesson["participants"], 1):
                assigned = client.post(
                    f"/api/sessions/{lesson['id']}/assignments",
                    headers=teacher,
                    json={
                        "participant_id": participant["user_id"],
                        "scenario_id": scenario["id"],
                        "order": index,
                        "planned_at": (datetime.now(UTC) + timedelta(days=1)).isoformat(),
                    },
                )
                assert assigned.status_code == 201, assigned.text
            started = client.post(f"/api/sessions/{lesson['id']}/start", headers=teacher)
            assert started.status_code == 200, started.text
            return lesson["id"]

        def assert_scope(snapshots, lesson_id):
            assert lesson_id in {s["id"] for s in snapshots[0]["sessions"]}
            own = next(s for s in snapshots[1]["sessions"] if s["id"] == lesson_id)
            assert [p["user_id"] for p in own["participants"]] == [users["trainee01"]["id"]]
            assert lesson_id not in {s["id"] for s in snapshots[2]["sessions"]}

        try:
            wait_until(lambda: attempts >= 1)
            health = client.get("/api/health")
            assert health.status_code == 200
            assert health.json() == {
                "status": "degraded",
                "mode": "database",
                "database": "ok",
                "worker": "ok",
                "ai_provider": "off",
            }
            validate_json(health.json(), "urn:openapi#/components/schemas/Health")
            headers = [teacher, trainee, stranger, revoked]
            with ExitStack() as stack:
                sockets = [
                    stack.enter_context(client.websocket_connect("/ws", headers=h)) for h in headers
                ]
                for socket in sockets:
                    receive_type(socket, "snapshot")
                missed_on_start = create_started_lesson()
                allow = True
                wait_until(lambda: hub.healthy)
                for socket in sockets:
                    expect_reconnect(socket)
            assert client.get("/api/health").json()["status"] == "ok"

            with ExitStack() as stack:
                sockets = [
                    stack.enter_context(client.websocket_connect("/ws", headers=h)) for h in headers
                ]
                assert_scope([receive_type(s, "snapshot") for s in sockets], missed_on_start)
                allow = False
                pid = hub.listener.get_server_pid()

                async def disconnect():
                    async with app.state.database.sessions.begin() as db:
                        # Завершается ровно соединение хаба этой случайной pytest-БД.
                        assert await db.scalar(
                            text(
                                "SELECT datname = current_database() "
                                "FROM pg_stat_activity WHERE pid=:pid"
                            ),
                            {"pid": pid},
                        )
                        assert await db.scalar(
                            text("SELECT pg_terminate_backend(:pid)"), {"pid": pid}
                        )

                client.portal.call(disconnect)
                wait_until(lambda: not hub.healthy)
                assert client.get("/api/health").json()["status"] == "degraded"
                missed_on_disconnect = create_started_lesson()
                assert client.post("/api/auth/logout", headers=revoked).status_code == 200
                allow = True
                wait_until(lambda: hub.healthy and hub.listener.get_server_pid() != pid)
                for socket in sockets:
                    expect_reconnect(socket)

            with ExitStack() as stack:
                sockets = [
                    stack.enter_context(client.websocket_connect("/ws", headers=h))
                    for h in headers[:3]
                ]
                assert_scope([receive_type(s, "snapshot") for s in sockets], missed_on_disconnect)
                with pytest.raises(WebSocketDisconnect) as denied:
                    with client.websocket_connect("/ws", headers=revoked):
                        pass
                assert denied.value.code == 4401
                live = create_started_lesson()
                assert receive_type(sockets[0], "session.started")["id"] == live
                own = receive_type(sockets[1], "session.started")
                assert own["id"] == live and len(own["participants"]) == 1
                # Pong стоит после уже обработанного NOTIFY: чужое событие не приходит.
                sockets[2].send_json(
                    {"type": "clock.ping", "client_ts": datetime.now(UTC).isoformat()}
                )
                while (event := sockets[2].receive_json())["type"] != "clock.pong":
                    assert event["type"] == "presence"

                async def listener_count():
                    async with app.state.database.sessions() as db:
                        return await db.scalar(
                            text(
                                "SELECT count(*) FROM pg_stat_activity "
                                "WHERE datname=current_database() "
                                "AND application_name='arm112-realtime'"
                            )
                        )

                assert client.portal.call(listener_count) == 1
        finally:
            client.portal.call(heartbeat, False)
    assert not hub.healthy
    assert hub.listener is None and hub.supervisor is None
    assert not hub.tasks and not hub.clients
