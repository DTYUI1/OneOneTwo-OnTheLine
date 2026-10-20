"""Параллельная работа: бригада звонит сама с готовым докладом (решение 27.09)."""

from datetime import UTC, datetime, timedelta
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from app.api.database import create_database_app
from app.api.evaluations.service import evaluation_context
from app.core.contracts import validate_json
from app.core.models import Call, MessageDelivery
from app.worker import training as worker_training
from fastapi.testclient import TestClient
from sqlalchemy import select

from . import test_c03_sessions as c03
from .briefing_helpers import briefing_payload
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
        # «Выехали» — в разговоре сразу после вводной (GP-05).
        send(client, headers, card_id, "brigade_briefing", briefing_payload(card, dispatch))
        now = datetime.now(UTC)
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
        # Пока не ответили, второй вызов той же бригады не создаётся (звонит 25 с, TC-02).
        assert worker_tick(database_url, later + timedelta(seconds=20)) == 0

        # Ответ — обычный call_answer: готовый доклад выдаётся в этот разговор
        # (тик worker — на тех же «часах», что и звонок бригады).
        send(client, headers, card_id, "call_answer", {"call_id": incoming["call_id"]})
        answered_tick(database_url, later + timedelta(seconds=21))
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
        finish_practice(client, headers, session["id"])

    async def outbound_only(db):
        context, *_ = await evaluation_context(db, UUID(card_id))
        return [call["id"] for call in context.calls]

    assert run_db(database_url, outbound_only) == [dispatch]


def test_ringing_call_blocks_redial_until_dispatcher_finishes_it(database_config, database_url):
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
        send(client, headers, card_id, "brigade_briefing", briefing_payload(card, first))
        send(client, headers, card_id, "call_hangup", {"call_id": first})
        # «Выехали» выдан, но не прозвучал — бригада перезвонит с ним.
        now = datetime.now(UTC) + timedelta(seconds=10)
        assert worker_tick(database_url, now) == 1
        (incoming,) = client.get(f"/api/cards/{card_id}/training").json()["incoming"]

        # Входящий вызов уже занимает линию: второй набор не должен создавать звонок.
        second = str(uuid4())
        send(client, headers, card_id, "call_dial_target", {**dial, "call_id": second}, 409)
        assert client.get(f"/api/calls/{second}").status_code == 404
        assert client.get(f"/api/calls/{incoming['call_id']}").json()["state"] == "ringing"
        send(client, headers, card_id, "call_answer", {"call_id": incoming["call_id"]})
        (pending,) = client.get(f"/api/cards/{card_id}/training").json()["messages"]
        send(client, headers, card_id, "message_presented", playback(pending["delivery"]))
        worker_tick(database_url, now + timedelta(seconds=1))
        assert deliveries(database_url, UUID(card_id)) == 1
        send(client, headers, card_id, "call_hangup", {"call_id": incoming["call_id"]})
        ended = client.get(f"/api/calls/{incoming['call_id']}").json()
        assert ended["state"] == "ended"
        assert client.get(f"/api/cards/{card_id}/training").json()["incoming"] == []
        finish_practice(client, headers, session["id"])


def answered_tick(url, now) -> None:
    """Тик worker после ответа на звонок бригады; сколько он выдал — не проверяем.

    Ответ на звонок сам выдаёт готовый доклад (`cards/service.py`, `deliver_messages` по
    `call_answer`), но по часам API — настоящим, а тики здесь идут по сдвинутым. Медленный
    прогон (полный набор под нагрузкой) успевает дожить до готовности доклада, и его выдаёт
    уже ответ, а тик выдаёт 0 (ночь 17→18.10, HQ-039). Проверяем итог — число выданных."""
    worker_tick(url, now)


def finish_practice(client, headers, session_id):
    """Тренировка закончена: её бригады больше не звонят в тиках других тестов (общая БД)."""
    response = client.post(f"/api/sessions/{session_id}/finish", headers=headers)
    assert response.status_code == 200, response.text


def arrival_ready(client, headers, database_url):
    """Тренировка до готового доклада о прибытии: «Выехали» услышан, бригада не на линии."""
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
    dial = {"call_id": dispatch, "call_target_id": target_id, "brigade_id": brigade_id}
    send(client, headers, card_id, "call_dial_target", dial)
    send(client, headers, card_id, "call_answer", {"call_id": dispatch})
    send(client, headers, card_id, "brigade_briefing", briefing_payload(card, dispatch))
    now = datetime.now(UTC)
    first = client.get(f"/api/cards/{card_id}/training").json()["messages"][0]
    send(client, headers, card_id, "message_presented", playback(first["delivery"]))
    send(client, headers, card_id, "status_change", {"state": "responding", "comment": "Выезд"})
    send(client, headers, card_id, "call_hangup", {"call_id": dispatch})
    return card_id, dial, now + timedelta(seconds=60), session["id"]


def callbacks(client, card_id):
    training = client.get(f"/api/cards/{card_id}/training").json()
    validate_json(training, "urn:openapi#/components/schemas/CardTraining")
    return training["incoming"], training["callbacks"]


def test_missed_call_then_lost_and_callback_gets_same_report(database_config, database_url):
    """TC-02: 25 с — пропущенный, через 40 с снова; второй пропуск — потерян; перезвон —
    тот же доклад."""
    seed_training(database_url)
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, TRAINEE)
        card_id, dial, later, session_id = arrival_ready(client, headers, database_url)
        assert worker_tick(database_url, later) == 1
        (first,), _ = callbacks(client, card_id)

        # Не ответили 25 с — пропущенный: вызов погашен, звонка нет.
        assert worker_tick(database_url, later + timedelta(seconds=26)) == 0
        incoming, history = callbacks(client, card_id)
        assert incoming == []
        assert [(c["call_id"], c["end_reason"]) for c in history] == [(first["call_id"], "missed")]
        assert client.get(f"/api/calls/{first['call_id']}").json()["state"] == "ended"
        # Ответ на погашенный вызов — 409 со стабильным кодом: очередь карточки не встаёт.
        late = send(
            client, headers, card_id, "call_answer", {"call_id": first["call_id"]}, expected=409
        )
        assert late.json()["code"] == "call_ended"

        # Бригада ждёт перезвона 40 с и звонит снова.
        assert worker_tick(database_url, later + timedelta(seconds=60)) == 0
        assert worker_tick(database_url, later + timedelta(seconds=67)) == 1
        (second,), _ = callbacks(client, card_id)
        assert second["call_id"] != first["call_id"]

        # Второй пропуск того же доклада — потерян: сама бригада больше не звонит.
        assert worker_tick(database_url, later + timedelta(seconds=93)) == 0
        _, history = callbacks(client, card_id)
        assert [c["end_reason"] for c in history] == ["missed", "lost"]
        assert worker_tick(database_url, later + timedelta(seconds=300)) == 0
        assert callbacks(client, card_id)[0] == []
        assert deliveries(database_url, UUID(card_id)) == 1

        # Перезвон старшему отдаёт пропущенный доклад — тот, с которым бригада звонила.
        callback = str(uuid4())
        send(client, headers, card_id, "call_dial_target", {**dial, "call_id": callback})
        send(client, headers, card_id, "call_answer", {"call_id": callback})
        answered_tick(database_url, later + timedelta(seconds=301))
        assert deliveries(database_url, UUID(card_id)) == 2

        async def last_delivery(db):
            return await db.scalar(
                select(MessageDelivery)
                .where(MessageDelivery.card_id == UUID(card_id))
                .order_by(MessageDelivery.delivered_at.desc())
                .limit(1)
            )

        delivery = run_db(database_url, last_delivery)
        assert str(delivery.call_id) == callback
        assert str(delivery.brigade_id) == dial["brigade_id"]
        assert delivery.ready_at <= datetime.fromisoformat(first["started_at"])
        finish_practice(client, headers, session_id)


def test_alarm_call_is_never_missed(database_config, database_url, monkeypatch):
    """Тревожный вызов звонит до ответа (решение 15.10, #97): пропущенным не гаснет."""
    seed_training(database_url)
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, TRAINEE)
        card_id, dial, later, session_id = arrival_ready(client, headers, database_url)
        alarm = worker_training.event_view

        async def alarm_view(db, card, brigades):
            view = await alarm(db, card, brigades)
            view.alarm_brigades.add(UUID(dial["brigade_id"]))
            return view

        monkeypatch.setattr(worker_training, "event_view", alarm_view)
        assert worker_tick(database_url, later) == 1
        assert worker_tick(database_url, later + timedelta(seconds=90)) == 0
        incoming, history = callbacks(client, card_id)
        assert len(incoming) == 1
        assert history[0]["end_reason"] is None and history[0]["ended_at"] is None
        finish_practice(client, headers, session_id)


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
