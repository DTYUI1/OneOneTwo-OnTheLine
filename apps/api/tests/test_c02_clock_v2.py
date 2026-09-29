"""C-02: синхронизация часов ws_midpoint_v2 и проверенное время попытки (I-TIME)."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

from app.api.database import create_database_app
from app.core.contracts import validate_json
from fastapi.testclient import TestClient

from .test_c03_sessions import batch, item, lesson, start, tick  # noqa: F401
from .test_lifecycle import event, login

ORIGIN = {"origin": "http://testserver"}


def iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def pong(socket, sample_id: str, client_ts: str) -> dict:
    socket.send_json({"type": "clock.ping.v2", "sample_id": sample_id, "client_ts": client_ts})
    while True:
        message = socket.receive_json()
        if message["type"] == "clock.pong.v2":
            validate_json(message, "urn:openapi#/components/schemas/WsServerEvent")
            return message


def sample(client, headers, received_shift_ms=40) -> dict:
    """Пройти ping/pong v2 и вернуть тело ClockSample с поправкой по формуле."""
    sample_id = str(uuid4())
    sent = datetime.now(UTC).replace(microsecond=0)
    with client.websocket_connect("/ws", headers=ORIGIN) as socket:
        message = pong(socket, sample_id, iso(sent))
    assert message["payload"] == {"sample_id": sample_id, "client_ts": iso(sent)}
    server_at = parse(message["server_ts"])
    received = sent + timedelta(milliseconds=received_shift_ms)
    offset = (server_at - (sent + (received - sent) / 2)).total_seconds() * 1000
    return {
        "sample_id": sample_id,
        "method": "ws_midpoint_v2",
        "client_sent_at": iso(sent),
        "server_at": iso(server_at),
        "client_received_at": iso(received),
        "offset_ms": offset,
    }


def test_sample_confirmation_rules(database_client):
    client = database_client
    headers = login(client, "trainee01")
    body = sample(client, headers)
    response = client.post("/api/clock/samples", json=body, headers=headers)
    assert response.status_code == 200, response.text
    validate_json(response.json(), "urn:openapi#/components/schemas/ClockSampleReceipt")
    assert response.json() == {"sample_id": body["sample_id"], "accepted": True, "reason": None}
    # Повтор того же тела — прежняя квитанция; другая поправка после подтверждения — 409.
    assert client.post("/api/clock/samples", json=body, headers=headers).json()["accepted"]
    changed = {**body, "offset_ms": body["offset_ms"] + 50}
    assert client.post("/api/clock/samples", json=changed, headers=headers).status_code == 409

    wrong = sample(client, headers)
    bad_formula = {**wrong, "offset_ms": wrong["offset_ms"] + 5000}
    rejected = client.post("/api/clock/samples", json=bad_formula, headers=headers).json()
    assert rejected["accepted"] is False and "формуле" in rejected["reason"]
    forged = {**wrong, "server_at": iso(parse(wrong["server_at"]) + timedelta(seconds=1))}
    assert client.post("/api/clock/samples", json=forged, headers=headers).status_code == 409

    other = login(client, "trainee02")
    assert client.post("/api/clock/samples", json=wrong, headers=other).status_code == 404
    teacher = login(client)
    assert client.post("/api/clock/samples", json=wrong, headers=teacher).status_code == 403


def test_repeated_ping_keeps_server_time_and_conflict_closes(database_client):
    client = database_client
    login(client, "trainee01")
    sample_id, sent = str(uuid4()), iso(datetime.now(UTC))
    with client.websocket_connect("/ws", headers=ORIGIN) as socket:
        first = pong(socket, sample_id, sent)
        second = pong(socket, sample_id, sent)
        assert first["server_ts"] == second["server_ts"]
        socket.send_json(
            {
                "type": "clock.ping.v2",
                "sample_id": sample_id,
                "client_ts": iso(datetime.now(UTC) + timedelta(seconds=5)),
            }
        )
        try:
            while True:
                assert socket.receive_json()["type"] != "clock.pong.v2"
        except Exception as closed:  # noqa: BLE001 — ждём закрытие 4400
            assert getattr(closed, "code", None) == 4400


def test_verified_timing_with_confirmed_samples(lesson, database_config, database_url):  # noqa: F811
    batch(lesson, [item(lesson), item(lesson, participant=1)])
    start(lesson)
    tick(database_url)
    with TestClient(create_database_app(database_config)) as trainee:
        headers = login(trainee, "trainee01")
        card = next(c for c in trainee.get("/api/cards").json() if c["session_id"] == lesson.id)
        body = sample(trainee, headers)
        unconfirmed = {**event("deliver", {}), "clock_sample_id": body["sample_id"]}
        response = trainee.post(
            f"/api/cards/{card['id']}/events", json=unconfirmed, headers=headers
        )
        assert response.status_code == 422 and response.json()["code"] == "clock_sample_unknown"
        assert trainee.post("/api/clock/samples", json=body, headers=headers).json()["accepted"]
        for kind, payload in [
            ("deliver", {}),
            ("open", {}),
            ("status_change", {"state": "accepted", "comment": "Принята"}),
            ("status_change", {"state": "responding", "comment": "Выезд"}),
            ("status_change", {"state": "completed", "comment": "Завершено"}),
        ]:
            # Время события — сразу после получения ответа сервера, в пределах 60 с образца.
            action = event(kind, payload)
            action["client_ts"] = body["client_received_at"]
            action["clock_sample_id"] = body["sample_id"]
            response = trainee.post(f"/api/cards/{card['id']}/events", json=action, headers=headers)
            assert response.status_code == 200, response.text
        timing = trainee.get(f"/api/cards/{card['id']}/analysis").json()["timing"]
        assert timing["timing_version"] == 3
        assert timing["quality"] == "verified", timing
        assert {e["source"] for e in timing["evidence"]} == {"server", "corrected_client"}
        assert timing["reaction_overdue"] is not None and timing["handling_overdue"] is not None
