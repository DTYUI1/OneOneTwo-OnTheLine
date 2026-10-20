"""Показ экрана ученика преподавателю (HQ-017): RBAC, лимиты кадров, аудит, конец занятия."""

import asyncio
import time
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from app.api import __main__ as api_main
from app.api.database import create_database_app
from app.api.screens import hub as hub_module
from app.api.screens.hub import (
    MAX_DROPS_IN_ROW,
    MAX_FRAME_BYTES,
    MIN_FRAME_INTERVAL_S,
    RUNNING_CHECK_S,
    WS_MAX_BYTES,
    ScreenHub,
    Share,
)
from app.core.config import ROOT
from app.core.contracts import validate_json
from app.core.models import AuditLog
from fastapi.testclient import TestClient
from sqlalchemy import select
from starlette.websockets import WebSocketDisconnect

JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 1000


def wait_until(predicate, what="условие"):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError(f"Не дождались: {what}")


def receive_type(socket, kind):
    while True:
        event = socket.receive_json()
        if event["type"] == kind:
            validate_json(event, "urn:openapi#/components/schemas/WsServerEvent")
            return event["payload"]


def refused(client, url, headers) -> int:
    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect(url, headers=headers) as socket:
            socket.receive_bytes()
    return closed.value.code


class FakeRealtime:
    async def send_to(self, *args):
        return None


def test_frame_limits_drop_excess():
    """5 кадров/с с запасом 150 мс; большой и не-JPEG кадр — отбрасываются, не рвут показ."""
    hub = ScreenHub(FakeRealtime())  # type: ignore[arg-type]
    share = Share(uuid4(), uuid4(), uuid4(), datetime.now(UTC))
    assert hub.accept_frame(share, JPEG, now=10.0)
    assert not hub.accept_frame(share, JPEG, now=10.0 + MIN_FRAME_INTERVAL_S / 2)
    assert hub.accept_frame(share, JPEG, now=10.0 + MIN_FRAME_INTERVAL_S)
    assert not hub.accept_frame(share, b"\xff\xd8" + b"\x00" * MAX_FRAME_BYTES, now=20.0)
    assert not hub.accept_frame(share, b"PNG not jpeg", now=30.0)
    assert (share.seq, hub.dropped, share.frame) == (2, 3, JPEG)
    # За секунду при попытке слать 30 кадров/с проходит не больше 7 (≈ 1 / 0,15).
    taken = sum(hub.accept_frame(share, JPEG, now=40.0 + i / 30) for i in range(30))
    assert taken <= 7


def test_ws_max_size_bounds_frames_everywhere():
    """uvicorn не буферизует 16 МиБ: предел WS-сообщения чуть больше кадра и один везде."""
    assert MAX_FRAME_BYTES + 16 < WS_MAX_BYTES <= 512 * 1024
    assert api_main.RUN_OPTIONS["ws_max_size"] == WS_MAX_BYTES
    dev = (ROOT / "deploy/docker-compose.dev.yml").read_text(encoding="utf-8")
    assert f"--ws-max-size, '{WS_MAX_BYTES}'" in dev
    readme = (ROOT / "deploy/README.md").read_text(encoding="utf-8")
    assert f"--ws-max-size {WS_MAX_BYTES}" in readme


def test_drops_in_row_reset_by_good_frame():
    hub = ScreenHub(FakeRealtime())  # type: ignore[arg-type]
    share = Share(uuid4(), uuid4(), uuid4(), datetime.now(UTC))
    for _ in range(MAX_DROPS_IN_ROW - 1):
        hub.accept_frame(share, b"junk", now=1.0)
    assert share.drops_in_row == MAX_DROPS_IN_ROW - 1
    assert hub.accept_frame(share, JPEG, now=2.0) and share.drops_in_row == 0


class FakeSocket:
    def __init__(self) -> None:
        self.closed: int | None = None

    async def close(self, code: int = 1000) -> None:
        self.closed = code


def test_lost_notify_finish_closes_share(monkeypatch):
    """NOTIFY session.finished потерян — показ гасит проверка статуса (кэш RUNNING_CHECK_S)."""
    lesson = SimpleNamespace(status="running")
    calls = []

    async def get_session(db, session_id):
        calls.append(session_id)
        return lesson

    @asynccontextmanager
    async def sessions():
        yield None

    monkeypatch.setattr(hub_module.session_repo, "get_session", get_session)
    realtime = FakeRealtime()
    realtime.app = SimpleNamespace(  # type: ignore[attr-defined]
        state=SimpleNamespace(database=SimpleNamespace(sessions=sessions))
    )
    hub = ScreenHub(realtime)  # type: ignore[arg-type]
    session_id, user_id = uuid4(), uuid4()

    async def scenario():
        assert await hub.still_running(session_id, now=0.0)
        lesson.status = "finished"
        # В пределах кэша БД не спрашиваем — кадр за кадром это дёшево.
        assert await hub.still_running(session_id, now=RUNNING_CHECK_S / 2)
        assert len(calls) == 1
        publisher, watcher = FakeSocket(), FakeSocket()
        share = await hub.request(session_id, uuid4(), user_id)
        share.publisher = publisher  # type: ignore[assignment]
        hub.viewers.append(hub_module.Viewer(watcher, session_id))  # type: ignore[arg-type]
        hub.running[session_id] = (time.monotonic() - RUNNING_CHECK_S, True)
        assert not await hub._ensure_running(session_id)
        return publisher.closed, watcher.closed

    assert asyncio.run(scenario()) == (1000, 4000)
    assert hub.shares == {} and len(calls) == 2


def fake_database(monkeypatch, lesson, calls, delay=0.0):
    async def get_session(db, session_id):
        calls.append(session_id)
        await asyncio.sleep(delay)
        return lesson

    @asynccontextmanager
    async def sessions():
        yield None

    monkeypatch.setattr(hub_module.session_repo, "get_session", get_session)
    realtime = FakeRealtime()
    realtime.app = SimpleNamespace(  # type: ignore[attr-defined]
        state=SimpleNamespace(database=SimpleNamespace(sessions=sessions))
    )
    return ScreenHub(realtime)  # type: ignore[arg-type]


def test_paused_frames_not_kept_but_limited():
    """Пауза: кадр не хранится и не пересылается, но частота и формат ограничены как обычно."""
    hub = ScreenHub(FakeRealtime())  # type: ignore[arg-type]
    share = Share(uuid4(), uuid4(), uuid4(), datetime.now(UTC))
    assert hub.accept_frame(share, JPEG, now=10.0, keep=False)
    assert (share.frame, share.seq, hub.dropped) == (None, 0, 0)
    assert not hub.accept_frame(share, JPEG, now=10.0 + MIN_FRAME_INTERVAL_S / 2, keep=False)
    assert not hub.accept_frame(share, b"junk", now=20.0, keep=False)
    assert (share.drops_in_row, hub.dropped) == (2, 2)


class FloodSocket(FakeSocket):
    """Ученик на паузе шлёт кадры подряд, без паузы между ними."""

    def __init__(self, frames: int) -> None:
        super().__init__()
        self.left = frames

    async def accept(self) -> None:
        return None

    async def receive(self) -> dict:
        if self.closed is not None or self.left == 0:
            return {"type": "websocket.disconnect"}
        self.left -= 1
        return {"type": "websocket.receive", "bytes": JPEG}


def test_paused_flood_closes_4400():
    hub = ScreenHub(FakeRealtime())  # type: ignore[arg-type]
    share = Share(uuid4(), uuid4(), uuid4(), datetime.now(UTC))
    hub.shares[(share.session_id, share.user_id)] = share
    socket = FloodSocket(MAX_DROPS_IN_ROW * 3)

    async def scenario():
        hub.running[share.session_id] = (time.monotonic(), True)
        assert not hub.watched(share.session_id)
        await hub._serve_publisher(socket, share)  # type: ignore[arg-type]

    asyncio.run(scenario())
    assert socket.closed == hub_module.CLOSE_BAD_MESSAGE
    assert share.frame is None and share.publisher is None


def test_still_running_one_query_per_lesson(monkeypatch):
    """Кэш истёк у всех сопрограмм занятия разом — в БД один запрос, не по запросу на сокет."""
    calls: list[UUID] = []
    hub = fake_database(monkeypatch, SimpleNamespace(status="running"), calls, delay=0.05)
    session_id = uuid4()

    async def scenario():
        answers = await asyncio.gather(*(hub.still_running(session_id) for _ in range(10)))
        assert all(answers) and hub.checks == {}

    asyncio.run(scenario())
    assert len(calls) == 1


def test_sweep_drops_orphaned_requests_after_lost_notify(monkeypatch):
    """Потерян NOTIFY: показ в requested без сокетов и кэш статуса чистит sweep."""
    calls: list[UUID] = []
    lesson = SimpleNamespace(status="running")
    hub = fake_database(monkeypatch, lesson, calls)
    finished, other, live = uuid4(), uuid4(), uuid4()
    watcher = FakeSocket()

    async def scenario():
        await hub.request(finished, uuid4(), uuid4())
        await hub.request(live, uuid4(), uuid4())
        hub.viewers.append(hub_module.Viewer(watcher, live))  # type: ignore[arg-type]
        hub.running[other] = (0.0, True)
        lesson.status = "finished"
        start = time.monotonic() + RUNNING_CHECK_S
        await hub.sweep(now=start)
        assert [share.session_id for share in hub.shares.values()] == [live]
        # Сессию со зрителем проверяет его собственный цикл — sweep её не трогает.
        assert calls == [finished] and watcher.closed is None
        assert other not in hub.running
        # Не чаще раза в RUNNING_CHECK_S.
        hub.running.clear()
        await hub.request(finished, uuid4(), uuid4())
        await hub.sweep(now=start + RUNNING_CHECK_S / 2)
        assert finished in {share.session_id for share in hub.shares.values()}
        assert len(calls) == 1

    asyncio.run(scenario())


def test_screen_share_rbac_frames_audit_and_finish(database_config):
    app = create_database_app(database_config)
    with TestClient(app) as client:
        hub = app.state.screens

        def login(name):
            response = client.post(
                "/api/auth/login", json={"login": name, "password": "test-password"}
            )
            assert response.status_code == 200, response.text
            return {
                "cookie": "; ".join(f"{key}={value}" for key, value in client.cookies.items()),
                "X-CSRF-Token": client.cookies["csrf"],
            }

        admin = login("admin")
        other_login = f"teacher_{uuid4().hex[:8]}"
        created = client.post(
            "/api/users",
            headers=admin,
            json={
                "login": other_login,
                "full_name": "Другой преподаватель",
                "role": "teacher",
                "password": "test-password",
                "workstation_number": None,
                "dds_service_id": None,
            },
        )
        assert created.status_code == 201, created.text
        teacher = login("teacher")
        users = {item["login"]: item for item in client.get("/api/users").json()}
        settings = client.get("/api/settings").json()
        scenario = next(
            item for item in client.get("/api/scenarios").json() if item["status"] == "approved"
        )
        lesson = client.post(
            "/api/sessions",
            headers=teacher,
            json={
                "title": f"Показ экрана {uuid4()}",
                "participants": [
                    {
                        "user_id": users[name]["id"],
                        "workstation_number": index,
                        "dds_service_id": "102",
                        "level": 1,
                    }
                    for index, name in enumerate(["trainee01", "trainee02"], 1)
                ],
                "settings_snapshot": settings,
            },
        ).json()
        session_id = lesson["id"]
        base = f"/api/sessions/{session_id}/screens"
        trainee01 = users["trainee01"]["id"]
        # Занятие ещё не идёт — смотреть нечего.
        assert client.post(f"{base}/{trainee01}/request", headers=teacher).status_code == 409
        for order, participant in enumerate(lesson["participants"], 1):
            assigned = client.post(
                f"/api/sessions/{session_id}/assignments",
                headers=teacher,
                json={
                    "participant_id": participant["user_id"],
                    "scenario_id": scenario["id"],
                    "order": order,
                    "planned_at": (datetime.now(UTC) + timedelta(days=1)).isoformat(),
                },
            )
            assert assigned.status_code == 201, assigned.text
        started = client.post(f"/api/sessions/{session_id}/start", headers=teacher)
        assert started.status_code == 200, started.text

        other = login(other_login)
        student = login("trainee01")
        neighbour = login("trainee02")
        stranger = login("trainee03")
        admin = login("admin")
        wait_until(lambda: hub.realtime.healthy, "LISTEN")

        with (
            client.websocket_connect("/ws", headers=teacher) as teacher_events,
            client.websocket_connect("/ws", headers=student) as student_events,
        ):
            receive_type(teacher_events, "snapshot")
            receive_type(student_events, "snapshot")

            # RBAC HTTP: просит только автор занятия и только участника занятия.
            assert client.post(f"{base}/{trainee01}/request", headers=student).status_code == 403
            assert client.post(f"{base}/{trainee01}/request", headers=other).status_code == 404
            assert client.get(base, headers=other).status_code == 404
            assert client.get(base, headers=admin).status_code == 403
            assert client.get(base, headers=stranger).status_code == 404
            outsider = users["trainee03"]["id"]
            assert client.post(f"{base}/{outsider}/request", headers=teacher).status_code == 422

            requested = client.post(f"{base}/{trainee01}/request", headers=teacher)
            assert requested.status_code == 201, requested.text
            validate_json(requested.json(), "urn:openapi#/components/schemas/ScreenShare")
            assert requested.json()["state"] == "requested"
            assert receive_type(teacher_events, "screen.state")["state"] == "requested"
            assert receive_type(student_events, "screen.state")["user_id"] == trainee01
            assert [s["user_id"] for s in client.get(base, headers=teacher).json()] == [trainee01]
            assert [s["user_id"] for s in client.get(base, headers=student).json()] == [trainee01]
            assert client.get(base, headers=neighbour).json() == []

            # RBAC кадров: без запроса, чужой ученик, чужой преподаватель, администратор — отказ.
            url = f"/ws/screen?session_id={session_id}"
            assert refused(client, url, neighbour) == 4404
            assert refused(client, url, stranger) == 4403
            assert refused(client, url, other) == 4403
            assert refused(client, url, admin) == 4403
            assert refused(client, f"/ws/screen?session_id={uuid4()}", teacher) == 4404

            with client.websocket_connect(url, headers=student) as publisher:
                # Преподаватель ещё не открыл плитки — показ включён, но на паузе.
                assert receive_type(student_events, "screen.state")["state"] == "paused"
                assert receive_type(teacher_events, "screen.state")["state"] == "paused"
                share = hub.shares[(UUID(session_id), UUID(trainee01))]
                dropped = hub.dropped
                publisher.send_bytes(JPEG + b"\x09")
                time.sleep(0.2)
                assert (share.frame, hub.dropped) == (None, dropped)

                with client.websocket_connect(url, headers=teacher) as viewer:
                    assert receive_type(student_events, "screen.state")["state"] == "sharing"
                    assert receive_type(teacher_events, "screen.state")["state"] == "sharing"
                    publisher.send_bytes(JPEG)
                    frame = viewer.receive_bytes()
                    assert UUID(bytes=frame[:16]) == UUID(trainee01) and frame[16:] == JPEG
                    # Сразу второй кадр — чаще 5 кадров/с, отброшен; большой — тоже.
                    publisher.send_bytes(JPEG + b"\x01")
                    publisher.send_bytes(b"\xff\xd8" + b"\x00" * MAX_FRAME_BYTES)
                    wait_until(lambda: hub.dropped == dropped + 2, "отброс лишних кадров")
                    time.sleep(MIN_FRAME_INTERVAL_S)
                    publisher.send_bytes(JPEG + b"\x02")
                    assert viewer.receive_bytes()[16:] == JPEG + b"\x02"

                # Преподаватель закрыл вкладку — ученик честно видит паузу, кадр не хранится.
                assert receive_type(student_events, "screen.state")["state"] == "paused"
                assert receive_type(teacher_events, "screen.state")["state"] == "paused"
                assert share.frame is None

                # Сосед не может остановить чужой показ; ученик — свой может.
                stop = f"{base}/{trainee01}/stop"
                assert client.post(stop, headers=neighbour).status_code == 404
                assert client.post(stop, headers=other).status_code == 404
                stopped = client.post(stop, headers=student)
                assert stopped.status_code == 200 and stopped.json()["state"] == "stopped"
                with pytest.raises(WebSocketDisconnect):
                    publisher.receive_bytes()
                assert receive_type(teacher_events, "screen.state")["state"] == "stopped"
                assert client.get(base, headers=teacher).json() == []

            with client.websocket_connect(url, headers=teacher) as viewer:
                # Текст вместо кадра — нарушение протокола.
                assert (
                    client.post(f"{base}/{trainee01}/request", headers=teacher).status_code == 201
                )
                with client.websocket_connect(url, headers=student) as again:
                    again.send_text("hello")
                    with pytest.raises(WebSocketDisconnect) as closed:
                        again.receive_bytes()
                    assert closed.value.code == 4400

                # Поток мусора: 20 отброшенных кадров подряд — закрытие 4400.
                with client.websocket_connect(url, headers=student) as flood:
                    for _ in range(MAX_DROPS_IN_ROW):
                        flood.send_bytes(b"PNG not jpeg")
                    with pytest.raises(WebSocketDisconnect) as closed:
                        flood.receive_bytes()
                    assert closed.value.code == 4400

                # Конец занятия закрывает показы и трансляцию преподавателю.
                finished = client.post(
                    f"/api/sessions/{session_id}/finish",
                    json={"contract_version": 2, "request_id": str(uuid4())},
                    headers=teacher,
                )
                assert finished.status_code == 200, finished.text
                with pytest.raises(WebSocketDisconnect) as closed:
                    viewer.receive_bytes()
                assert closed.value.code == 4000
                assert hub.session_shares(UUID(session_id)) == []

        async def audit():
            async with app.state.database.sessions() as db:
                rows = (
                    await db.scalars(
                        select(AuditLog)
                        .where(AuditLog.entity == "screen_share")
                        .where(AuditLog.entity_id == trainee01)
                        .order_by(AuditLog.ts)
                    )
                ).all()
            return [(row.action, row.after) for row in rows]

        actions = [action for action, after in client.portal.call(audit)]
        assert actions == ["requestScreenShare", "stopScreenShare", "requestScreenShare"]
