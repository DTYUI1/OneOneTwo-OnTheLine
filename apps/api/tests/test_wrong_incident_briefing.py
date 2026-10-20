"""HTTP → PostgreSQL → мир → сохранённая оценка API и worker при неверном поводе."""

import hashlib
import time
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from app.api.evaluations.service import evaluation_context
from app.api.training import briefing
from app.api.training.status_evidence import missing_report_states
from app.core.models import BrigadeBriefing, Card, CardBrigade, Evaluation
from app.worker.runtime import Worker
from evalcore.brigade import BrigadeWorkCriterion
from evalcore.criteria import AddressCriterion
from sqlalchemy import select

from . import test_brigade_briefing as briefing_tests
from .briefing_helpers import briefing_payload
from .test_brigade_briefing import GAS, accept, check, dial
from .test_lifecycle import run_db
from .test_live_brigade_flow import present, training
from .test_practice_gating import deliveries, send, worker_tick

briefing_card = briefing_tests.briefing_card


@pytest.mark.parametrize("briefing_card", [GAS], indirect=True)
@pytest.mark.parametrize("callback", [False, True])
def test_missing_composite_serves_prefix_and_original_recordings_without_500(
    briefing_card, database_url, monkeypatch, callback
):
    client, headers, card, target = briefing_card
    accept(client, headers, card)
    call_id = dial(client, headers, card, target)
    # Подмена только наличия составной записи: обе реальные исходные записи доступны.
    monkeypatch.setattr(briefing, "wrong_incident_items", lambda: {})
    send(
        client,
        headers,
        card["id"],
        "brigade_briefing",
        {"call_id": call_id, "mode": "voice", "text": "Улица Плеханова, 11. Пожар в квартире."},
    )
    (departure,) = training(client, card["id"])["messages"]
    present(client, headers, card["id"], departure)
    send(client, headers, card["id"], "status_change", {"state": "responding", "comment": "Выезд"})
    if callback:
        send(client, headers, card["id"], "call_hangup", {"call_id": call_id})
        worker_tick(database_url, datetime.now(UTC) + timedelta(seconds=10))
        (incoming,) = training(client, card["id"])["incoming"]
        call_id = incoming["call_id"]
        send(client, headers, card["id"], "call_answer", {"call_id": call_id})
    worker_tick(database_url, datetime.now(UTC) + timedelta(seconds=10))
    messages = training(client, card["id"])["messages"]
    notice = messages[1]
    assert notice["delivery"]["message"]["text"] == briefing.WRONG_INCIDENT_TEXT
    present(client, headers, card["id"], notice)
    send(
        client, headers, card["id"], "status_change", {"state": "arrived", "comment": "Прибыл"}, 409
    )
    if callback:
        assert len(messages) == 2  # Во входящем вызове бригада ждёт «Принял».
        send(
            client,
            headers,
            card["id"],
            "report_confirmed",
            {
                "call_id": call_id,
                "delivery_id": notice["delivery"]["delivery_id"],
                "text": "Принял.",
            },
        )
    worker_tick(database_url, datetime.now(UTC) + timedelta(seconds=10))
    departure, notice, original = training(client, card["id"])["messages"]
    assert (
        original["delivery"]["message"]["text"]
        == "Прибыли. В подъезде запах газа, сильнее всего наверху."
    )
    for item in (notice, original):
        assert item["delivery"]["call_id"] == call_id
        audio = item["delivery"]["message"]["audio"]
        response = client.get(audio["url"])
        assert response.status_code == 200
        assert hashlib.sha256(response.content).hexdigest() == audio["sha256"]
    worker_tick(database_url, datetime.now(UTC) + timedelta(seconds=10))
    assert deliveries(database_url, UUID(card["id"])) == 3
    present(client, headers, card["id"], original)
    send(client, headers, card["id"], "status_change", {"state": "arrived", "comment": "Прибыл"})


@pytest.mark.parametrize("briefing_card", [GAS], indirect=True)
@pytest.mark.parametrize("mode", ["voice", "parts"])
def test_wrong_incident_dispatch_arrival_and_persisted_score(
    briefing_card, database_url, database_config, mode, record_property
):
    client, headers, card, target = briefing_card
    card_id, brigade_id = UUID(card["id"]), UUID(target["brigade_id"])
    accept(client, headers, card)
    call_id = dial(client, headers, card, target)
    wrong = "Улица Плеханова, 11. Драка на улице"
    preview = check(client, headers, call_id, wrong)
    assert preview["incident"] is False
    assert preview["complete"] is True
    assert preview["ask_again"] is None
    assert preview["address"] == "ok"

    async def rows(db):
        return list(
            await db.scalars(select(BrigadeBriefing).where(BrigadeBriefing.card_id == card_id))
        )

    # Предварительная проверка ничего не сохраняет и не отправляет.
    assert run_db(database_url, rows) == []
    assert training(client, card["id"])["selected_brigade_ids"] == []
    send(
        client,
        headers,
        card["id"],
        "brigade_briefing",
        {"call_id": call_id, "mode": mode, "text": wrong},
    )
    # Поздняя поправка сохраняется, но не переписывает первую отправку.
    send(client, headers, card["id"], "brigade_briefing", briefing_payload(card, call_id, mode))
    stored = run_db(database_url, rows)
    assert [(row.incident, row.complete, row.mode, row.address) for row in stored] == [
        (False, True, mode, "ok"),
        (True, True, mode, "ok"),
    ]
    assert len(briefing.dispatching(stored)) == 1
    assert briefing.dispatching(stored)[brigade_id].text == wrong

    async def selected(db):
        return list(await db.scalars(select(CardBrigade).where(CardBrigade.card_id == card_id)))

    assert len(run_db(database_url, selected)) == 1
    (departure,) = training(client, card["id"])["messages"]
    assert departure["delivery"]["call_id"] == call_id
    present(client, headers, card["id"], departure)
    send(client, headers, card["id"], "status_change", {"state": "responding", "comment": "Выезд"})
    worker_tick(database_url, datetime.now(UTC) + timedelta(seconds=10))
    # Без дополнительной задержки и повторной отправки.
    assert deliveries(database_url, card_id) == 2
    arrival = training(client, card["id"])["messages"][-1]
    message = arrival["delivery"]["message"]
    assert message["text"].startswith(briefing.WRONG_INCIDENT_TEXT + " ")
    assert briefing.MOVED_TEXT not in message["text"]
    assert message["audio"] is not None
    recording = client.get(message["audio"]["url"])
    assert recording.status_code == 200, recording.text
    assert hashlib.sha256(recording.content).hexdigest() == message["audio"]["sha256"]
    assert message["text"].endswith("Прибыли. В подъезде запах газа, сильнее всего наверху.")
    present(client, headers, card["id"], arrival)
    send(
        client,
        headers,
        card["id"],
        "status_change",
        {"state": "arrived", "comment": message["text"]},
    )
    # Сценарий продолжает задавать исходный вопрос о людях, а не про выдуманный пожар.
    worker_tick(database_url, datetime.now(UTC) + timedelta(seconds=3))
    question = next(
        m for m in training(client, card["id"])["messages"] if "reply_options" in m["delivery"]
    )
    assert (
        question["delivery"]["message"]["text"]
        == "Внутри люди остались? Заявитель что-нибудь говорил?"
    )
    present(client, headers, card["id"], question)
    time.sleep(2.1)  # Реальный HTTP-ответ не может предшествовать сценарию: after_s=2.
    send(
        client,
        headers,
        card["id"],
        "brigade_reply",
        {
            "call_id": call_id,
            "delivery_id": question["delivery"]["delivery_id"],
            "option_key": "two",
        },
    )
    # Неверный повод не переписывает факты и дальнейший ход статусов.
    for state, delay in [("working", 10), ("completed", 41)]:

        async def blocked(db, state=state):
            return await missing_report_states(db, await db.get(Card, card_id), [state])

        for attempt in range(4):
            worker_tick(database_url, datetime.now(UTC) + timedelta(seconds=delay + attempt * 40))
            pending = [
                m for m in training(client, card["id"])["messages"] if m["state"] != "presented"
            ]
            for report in pending:
                text = report["delivery"]["message"]["text"]
                assert briefing.WRONG_INCIDENT_TEXT not in text
                present(client, headers, card["id"], report)
            if not run_db(database_url, blocked):
                break
        assert not run_db(database_url, blocked), f"Не получен исходный доклад этапа {state}"
        send(client, headers, card["id"], "status_change", {"state": state, "comment": text})

    async def score_and_persist(db):
        context, *_ = await evaluation_context(db, card_id)
        assert context.briefings[0]["incident"] is False
        assert context.scenario["card"]["incident_class"] == card["source"]["incident_class"]
        address = AddressCriterion().evaluate(context)
        work = BrigadeWorkCriterion().evaluate(context)
        assert not address.critical and address.score == 1
        assert not work.critical and work.score < 1
        assert "вводн" in work.explanation.lower()
        saved = await db.scalar(select(Evaluation).where(Evaluation.card_id == card_id))
        assert saved is not None  # Сохранено настоящим завершающим HTTP-событием.
        assert saved.rules_scores["brigade_work"] == work.score
        return saved.id, saved.rules_scores["brigade_work"], saved.critical_flags

    evaluation_id, api_score, flags = run_db(database_url, score_and_persist)
    assert "address" not in flags
    initial = client.get(f"/api/evaluations/{evaluation_id}")
    assert initial.status_code == 200, initial.text
    assert (
        next(c for c in initial.json()["criteria"] if c["key"] == "brigade_work")["score"]
        == api_score
    )

    async def worker_and_reload(db):
        worker = Worker(database_config)
        try:
            await worker.handlers.handle_evaluate(
                db, {"card_id": str(card_id), "evaluation_id": str(evaluation_id)}
            )
        finally:
            await worker.close()
        await db.flush()
        db.expire_all()
        saved = await db.get(Evaluation, evaluation_id)
        assert saved.rules_scores["brigade_work"] == api_score
        assert "address" not in saved.critical_flags
        return saved.id

    assert run_db(database_url, worker_and_reload) == evaluation_id
    reloaded = client.get(f"/api/evaluations/{evaluation_id}")
    assert reloaded.status_code == 200
    assert (
        next(c for c in reloaded.json()["criteria"] if c["key"] == "brigade_work")["score"]
        == api_score
    )
    record_property("card_id", str(card_id))
    record_property("call_id", call_id)
    record_property("evaluation_id", str(evaluation_id))
    record_property("first_briefed_at", stored[0].briefed_at.isoformat())
    record_property("arrival_message_id", message["id"])
    record_property("mode", mode)
    record_property("brigade_work", api_score)
