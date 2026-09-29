import asyncio
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest
from app.api.main import create_app
from app.core.config import settings
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator, FormatChecker
from starlette.websockets import WebSocketDisconnect


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(settings, "cookie_secure", False)
    monkeypatch.setattr(settings, "api_mode", "mock")
    with TestClient(create_app()) as client:
        yield client


def login(client, name="trainee01"):
    response = client.post(
        "/api/auth/login", json={"login": name, "password": settings.demo_password}
    )
    assert response.status_code == 200, response.text
    return response.json()


def post_event(client, event=None):
    card = client.get("/api/cards").json()[0]
    if event is None:
        event = {
            "client_event_id": str(uuid4()),
            "client_ts": "2026-09-19T09:00:10Z",
            "type": "open",
            "payload": {},
        }
    return client.post(
        f"/api/cards/{card['id']}/events",
        json=event,
        headers={"X-CSRF-Token": client.cookies["csrf"]},
    )


def test_auth_errors_and_cookie(client):
    assert client.get("/api/auth/me").status_code == 401
    assert (
        client.post("/api/auth/login", json={"login": "teacher", "password": "bad"}).status_code
        == 401
    )
    response = client.post(
        "/api/auth/login", json={"login": "teacher", "password": settings.demo_password}
    )
    assert "HttpOnly" in response.headers["set-cookie"]
    assert client.get("/api/auth/me").json()["role"] == "teacher"


def test_malformed_login(client):
    response = client.post(
        "/api/auth/login", content="{bad", headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 422
    assert set(response.json()) == {"code", "message", "details"}


def test_rbac_and_csrf(client):
    login(client)
    assert client.get("/api/users").status_code == 403
    assert client.get("/api/scenarios").status_code == 403
    assert client.post("/api/auth/logout").status_code == 403
    assert client.post("/api/auth/logout", headers={"X-CSRF-Token": "fake"}).status_code == 403
    assert (
        client.post(
            "/api/auth/logout", headers={"X-CSRF-Token": client.cookies["csrf"]}
        ).status_code
        == 200
    )
    assert client.get("/api/auth/me").status_code == 401


def test_duplicate_events_and_conflict(client):
    login(client)
    event = {
        "client_event_id": str(uuid4()),
        "client_ts": "2026-09-19T09:00:10Z",
        "type": "open",
        "payload": {},
    }
    first = post_event(client, event)
    second = post_event(client, event)
    assert first.status_code == second.status_code == 200
    assert first.json()["duplicate"] is False
    assert second.json()["duplicate"] is True
    assert first.json()["server_ts"] == second.json()["server_ts"]
    assert post_event(client, {**event, "type": "deliver"}).status_code == 409
    card_id = first.json()["card"]["id"]
    assert len(client.get(f"/api/cards/{card_id}/events").json()) == 1


@pytest.mark.parametrize(
    "changes",
    [
        {"type": "unknown"},
        {"client_event_id": "not-uuid"},
        {"client_ts": "yesterday"},
        {"type": "field_change", "payload": {"field": "address", "value": "x"}},
        {"type": "status_change", "payload": {"state": "completed", "comment": ""}},
        {"type": "call_dial", "payload": {"call_id": str(uuid4()), "phone_ext": "12"}},
    ],
)
def test_event_validation(client, changes):
    login(client)
    event = {
        "client_event_id": str(uuid4()),
        "client_ts": "2026-09-19T09:00:10Z",
        "type": "open",
        "payload": {},
    }
    assert post_event(client, {**event, **changes}).status_code == 422


def test_no_other_trainee_data(client):
    login(client)
    card_id = client.get("/api/cards").json()[0]["id"]
    evaluation_id = client.get("/api/evaluations").json()[0]["id"]
    login(client, "trainee02")
    for path in ["/cards", "/evaluations", "/sessions"]:
        assert client.get("/api" + path).json() == []
    assert client.get(f"/api/cards/{card_id}").status_code == 404
    assert client.get(f"/api/evaluations/{evaluation_id}").status_code == 404


def test_websocket_reconnect_and_contract(client):
    login(client)
    spec = client.app.openapi()
    validator = Draft202012Validator(
        {"components": spec["components"], "$ref": "#/components/schemas/WsServerEvent"},
        format_checker=FormatChecker(),
    )
    for _ in range(2):
        with client.websocket_connect("/ws") as socket:
            presence = socket.receive_json()
            snapshot = socket.receive_json()
            validator.validate(presence)
            validator.validate(snapshot)
            assert snapshot["type"] == "snapshot"
            assert len(snapshot["payload"]["cards"]) == 1
            socket.send_json({"type": "clock.ping", "client_ts": "2026-09-19T09:00:00Z"})
            pong = socket.receive_json()
            validator.validate(pong)
            assert pong["payload"]["client_ts"] == "2026-09-19T09:00:00Z"
            response = post_event(client)
            assert response.status_code == 200
            event = socket.receive_json()
            validator.validate(event)
            assert event["type"] == "card.updated"


def test_ws_requires_auth_and_same_origin(client):
    with pytest.raises(WebSocketDisconnect), client.websocket_connect("/ws"):
        pass
    login(client)
    with (
        pytest.raises(WebSocketDisconnect),
        client.websocket_connect("/ws", headers={"Origin": "https://other.invalid"}),
    ):
        pass


def test_ws_snapshot_is_private(client):
    login(client, "trainee02")
    with client.websocket_connect("/ws") as socket:
        socket.receive_json()
        assert socket.receive_json()["payload"]["cards"] == []


def test_all_get_response_examples_match_contract(client):
    spec = client.app.openapi()
    current = None
    examples = {
        name: schema.get("examples", [None])[0]
        for name, schema in spec["components"]["schemas"].items()
    }
    identifiers = {
        "cards": examples["Card"]["id"],
        "calls": examples["Call"]["id"],
        "evaluations": examples["Evaluation"]["id"],
        "sessions": examples["Session"]["id"],
        "scenarios": examples["Scenario"]["id"],
        "jobs": examples["Job"]["id"],
        "reports": examples["Session"]["id"],
    }
    for path, methods in spec["paths"].items():
        if "get" not in methods:
            continue
        route = path.replace("{id}", identifiers.get(path.split("/")[1], str(uuid4())))
        route = route.replace("{delivery_id}", str(uuid4()))
        # Каждая операция — от роли, которой она разрешена: у администратора нет доступа
        # к учебным данным (C-07), поэтому «суперпользователя» для обхода больше нет.
        roles = methods["get"]["x-roles"]
        name = next(
            login_name
            for role, login_name in (
                ("teacher", "teacher"),
                ("admin", "admin"),
                ("trainee", "trainee01"),
            )
            if role in roles
        )
        if name != current:
            login(client, name)
            current = name
        response = client.get("/api" + route)
        if methods["get"].get("x-implementation-status") == "contract-ready":
            # Spec-first формы доступны клиенту, но mock не выдаёт ложный успех.
            assert response.status_code == 501, (route, response.text)
            assert set(response.json()) == {"code", "message", "details"}
            continue
        assert response.status_code == 200, (route, response.text)
        content = methods["get"]["responses"]["200"]["content"]
        if "application/json" in content:
            Draft202012Validator(
                {"components": spec["components"], **content["application/json"]["schema"]},
                format_checker=FormatChecker(),
            ).validate(response.json())
        else:
            assert response.content.startswith(b"\xef\xbb\xbf")


def test_skeleton_mode_is_explicit(client, monkeypatch):
    monkeypatch.setattr(settings, "api_mode", "skeleton")
    assert client.get("/api/health").json()["mode"] == "skeleton"
    assert client.get("/api/cards").status_code == 501


def test_call_reads_match_events(client):
    login(client)
    call_id = str(uuid4())
    card_id = client.get("/api/cards").json()[0]["id"]
    for kind, state in [
        ("call_dial", "dialing"),
        ("call_answer", "talking"),
        ("call_hangup", "ended"),
    ]:
        payload = {"call_id": call_id}
        if kind == "call_dial":
            payload["phone_ext"] = "102"
        response = post_event(
            client,
            {
                "client_event_id": str(uuid4()),
                "client_ts": "2026-09-19T09:00:10Z",
                "type": kind,
                "payload": payload,
            },
        )
        assert response.status_code == 200
        call = client.get(f"/api/calls/{call_id}")
        assert call.status_code == 200
        assert call.json()["state"] == state
        assert call.json()["phone_ext"] == "102"
        assert client.get(f"/api/cards/{card_id}/calls").json() == [call.json()]
    login(client, "trainee02")
    assert client.get(f"/api/calls/{call_id}").status_code == 404


def test_logout_tolerates_already_closed_socket(client):
    user = login(client)
    socket = Mock()
    socket.cookies = {"session": client.cookies["session"]}
    socket.close = AsyncMock(side_effect=RuntimeError("Already closed"))
    client.app.state.backend.sockets[socket] = user
    response = client.post("/api/auth/logout", headers={"X-CSRF-Token": client.cookies["csrf"]})
    assert response.status_code == 200
    assert client.get("/api/auth/me").status_code == 401
    assert not client.app.state.backend.sockets


@pytest.mark.parametrize("disconnect_on", [1, 2])
def test_disconnect_during_initial_snapshot_does_not_leak_socket(client, disconnect_on):
    login(client)
    socket = Mock()
    socket.headers = {}
    socket.cookies = {"session": client.cookies["session"]}
    socket.accept = AsyncMock()
    socket.send_json = AsyncMock(side_effect=[None] * (disconnect_on - 1) + [WebSocketDisconnect()])
    asyncio.run(client.app.state.backend.websocket(socket))
    assert socket not in client.app.state.backend.sockets
