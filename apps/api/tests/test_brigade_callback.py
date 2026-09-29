"""Параллельная работа: бригада звонит сама с готовым докладом (решение 27.09)."""

from datetime import UTC, datetime, timedelta
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from app.api.database import create_database_app
from app.api.evaluations.service import evaluation_context
from app.core.contracts import validate_json
from app.core.models import Call
from fastapi.testclient import TestClient
from sqlalchemy import select

from . import test_c03_sessions as c03
from .test_c03_sessions import batch, item, lesson, start, tick  # noqa: F401
from .test_c04_completion import seed_training
from .test_c04_training import playback
from .test_lifecycle import event, login, run_db
from .test_practice_gating import deliveries, practice, send, worker_tick

# Свой обучаемый: тренировки других тестов идут в той же БД.
TRAINEE = "trainee05"


def calls(url, card_id) -> list[Call]:
    async def load(db):
        return list(
            await db.scalars(select(Call).where(Call.card_id == card_id).order_by(Call.started_at))
        )

    return run_db(url, load)


def test_brigade_calls_back_when_report_is_ready(database_config, database_url):
    seed_training(database_url)
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, TRAINEE)
        session = practice(client, headers)
        assert c03.tick(database_url) >= 1
        card = next(c for c in client.get("/api/cards").json() if c["session_id"] == session["id"])
        card_id = card["id"]
        service_id = session["participants"][0]["dds_service_id"]
        brigade_id = str(uuid5(NAMESPACE_URL, f"arm112:c04:{service_id}:brigade:0"))
        target_id = str(uuid5(NAMESPACE_URL, f"arm112:c04:{service_id}:target:0"))

        send(client, headers, card_id, "deliver", {})
        send(client, headers, card_id, "open", {})
        send(client, headers, card_id, "status_change", {"state": "accepted", "comment": "Принята"})
        send(client, headers, card_id, "brigades_select", {"brigade_ids": [brigade_id]})
        dispatch = str(uuid4())
        send(
            client,
            headers,
            card_id,
            "call_dial_target",
            {"call_id": dispatch, "call_target_id": target_id, "brigade_id": brigade_id},
        )
        send(client, headers, card_id, "call_answer", {"call_id": dispatch})
        # «Выехали» — в разговоре при отправке, как раньше.
        now = datetime.now(UTC)
        assert worker_tick(database_url, now + timedelta(seconds=10)) == 1
        assert deliveries(database_url, UUID(card_id)) == 1
        first = client.get(f"/api/cards/{card_id}/training").json()["messages"][0]
        send(client, headers, card_id, "message_presented", playback(first["delivery"]))
        send(client, headers, card_id, "status_change", {"state": "responding", "comment": "Выезд"})
        send(client, headers, card_id, "call_hangup", {"call_id": dispatch})

        # Диспетчер занят другой карточкой. Доклад о прибытии готов — бригада звонит сама.
        later = now + timedelta(seconds=60)
        assert worker_tick(database_url, later) == 1
        training = client.get(f"/api/cards/{card_id}/training").json()
        validate_json(training, "urn:openapi#/components/schemas/CardTraining")
        (incoming,) = training["incoming"]
        assert incoming["brigade_id"] == brigade_id
        ringing = client.get(f"/api/calls/{incoming['call_id']}").json()
        assert ringing["state"] == "ringing" and ringing["direction"] == "inbound"
        # Пока не ответили, второй вызов той же бригады не создаётся.
        assert worker_tick(database_url, later + timedelta(seconds=30)) == 0

        # Ответ — обычный call_answer: готовый доклад выдаётся в этот разговор
        # (тик worker — на тех же «часах», что и звонок бригады).
        send(client, headers, card_id, "call_answer", {"call_id": incoming["call_id"]})
        assert worker_tick(database_url, later + timedelta(seconds=31)) == 1
        assert deliveries(database_url, UUID(card_id)) == 2
        after = client.get(f"/api/cards/{card_id}/training").json()
        assert after["incoming"] == []
        # История вызовов: когда позвонила и когда ответили — для разбора.
        (callback,) = after["callbacks"]
        assert callback["call_id"] == incoming["call_id"]
        assert callback["answered_at"] is not None

        # Ожидание — пока бригада работала (секунды плана), а не пока диспетчер не отвечал.
        timing = client.get(f"/api/cards/{card_id}/analysis").json()["timing"]
        assert timing["waiting_s"] is not None and 0 < timing["waiting_s"] < 30

    async def outbound_only(db):
        context, *_ = await evaluation_context(db, UUID(card_id))
        return [call["id"] for call in context.calls]

    assert run_db(database_url, outbound_only) == [dispatch]


def test_ringing_call_ends_when_dispatcher_calls_brigade_himself(database_config, database_url):
    seed_training(database_url)
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, TRAINEE)
        session = practice(client, headers)
        assert c03.tick(database_url) >= 1
        card = next(c for c in client.get("/api/cards").json() if c["session_id"] == session["id"])
        card_id = card["id"]
        service_id = session["participants"][0]["dds_service_id"]
        brigade_id = str(uuid5(NAMESPACE_URL, f"arm112:c04:{service_id}:brigade:0"))
        target_id = str(uuid5(NAMESPACE_URL, f"arm112:c04:{service_id}:target:0"))
        send(client, headers, card_id, "deliver", {})
        send(client, headers, card_id, "open", {})
        send(client, headers, card_id, "status_change", {"state": "accepted", "comment": "Принята"})
        send(client, headers, card_id, "brigades_select", {"brigade_ids": [brigade_id]})
        first = str(uuid4())
        dial = {"call_id": first, "call_target_id": target_id, "brigade_id": brigade_id}
        send(client, headers, card_id, "call_dial_target", dial)
        send(client, headers, card_id, "call_answer", {"call_id": first})
        send(client, headers, card_id, "call_hangup", {"call_id": first})
        # «Выехали» не прозвучал — бригада перезвонит с ним.
        now = datetime.now(UTC) + timedelta(seconds=10)
        assert worker_tick(database_url, now) == 1
        (incoming,) = client.get(f"/api/cards/{card_id}/training").json()["incoming"]

        # Диспетчер сам набрал бригаду и услышал доклад — её входящий гаснет.
        second = str(uuid4())
        send(client, headers, card_id, "call_dial_target", {**dial, "call_id": second})
        send(client, headers, card_id, "call_answer", {"call_id": second})
        assert worker_tick(database_url, now + timedelta(seconds=1)) == 1
        assert deliveries(database_url, UUID(card_id)) == 1
        ended = client.get(f"/api/calls/{incoming['call_id']}").json()
        assert ended["state"] == "ended"
        assert client.get(f"/api/cards/{card_id}/training").json()["incoming"] == []


def test_final_rejected_card_frees_parallel_slot(lesson, database_config, database_url):  # noqa: F811
    batch(
        lesson,
        [item(lesson), item(lesson, order=2), item(lesson, order=3), item(lesson, participant=1)],
    )
    start(lesson)
    # Лимит первого обучаемого — 2 карточки; ещё одна у второго.
    assert tick(database_url) == 3
    with TestClient(create_database_app(database_config)) as trainee:
        headers = login(trainee, "trainee01")
        first = next(c for c in trainee.get("/api/cards").json() if c["session_id"] == lesson.id)
        for kind, payload in [
            ("deliver", {}),
            ("status_change", {"state": "rejected", "comment": "Не наша служба, передано"}),
        ]:
            response = trainee.post(
                f"/api/cards/{first['id']}/events", json=event(kind, payload), headers=headers
            )
            assert response.status_code == 200, (kind, response.text)
    # Окончательная «Не принята» не держит место: третья карточка выдаётся.
    assert tick(database_url) == 1
