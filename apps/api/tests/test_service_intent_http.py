"""Свободная весть о скорой: настоящий HTTP → PostgreSQL → мир и оценщик.

STT audio→text управляется FakeSTT; распознаватель смысла, HTTP, журнал,
загрузчик сценария MOSLIFT и доменные исходы не подменяются. Это не проверка ASR.
Запускать только после source-freeze, с изолированным DATABASE_URL_TEST.
"""

import time
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest
from app.api.training.brigades import card_crew
from app.api.training.scenario_events import (
    card_events_plan,
    cast_event,
    evaluation_events,
    load_journal,
    world,
)
from app.core.models import Card, CardEvent
from app.worker.providers.interfaces import Recognition
from evalcore.brigade import BrigadeWorkCriterion, resolve_event
from evalcore.models import EvalContext
from sqlalchemy import select

from . import test_final_scenarios as final
from .test_c04_completion import seed_training
from .test_final_scenarios import Shift, open_shift
from .test_lifecycle import run_db
from .test_live_brigade_flow import voice_reply
from .test_practice_gating import worker_tick
from .test_voice_report import FakeSTT

CODE = "lift-ill-moslift-2"
NEWS = "Вызванная скорая помощь"


def snapshot(shift: Shift) -> tuple[Any, dict, tuple, list]:
    """Каждый раз новое соединение: проверяем commit, не identity map HTTP-запроса."""

    async def read(db):
        card = await db.get(Card, UUID(shift.card_id))
        assert card is not None
        messages, events = await card_events_plan(db, card)
        crew = await card_crew(db, card, messages)
        event = next(item for item in events if item["kind"] == "request_service")
        event = cast_event(event, crew)
        journal = await load_journal(db, card, events=events)
        projected = tuple(
            item for item in await evaluation_events(db, card) if item["event"]["id"] == event["id"]
        )
        rows = list(
            await db.scalars(
                select(CardEvent)
                .where(
                    CardEvent.card_id == card.id,
                    CardEvent.type.in_(("brigade_reply", "brigade_said")),
                )
                .order_by(CardEvent.server_ts, CardEvent.id)
            )
        )
        return journal, event, projected, [(row.type, row.payload, row.server_ts) for row in rows]

    return run_db(shift.url, read)


def domain_state(shift: Shift):
    """Независимо читаем исход evalcore и расписание мира из одного реального журнала."""
    journal, event, projected, rows = snapshot(shift)
    assert len(projected) == 1
    item = projected[0]
    future = datetime.now(UTC) + timedelta(seconds=120)
    outcome = resolve_event(
        event=item["event"],
        fired_at=datetime.fromisoformat(item["fired_at"]),
        presented_at=datetime.fromisoformat(item["presented_at"]),
        replies=item["replies"],
        calls=journal.calls,
        now=future,
        said=item["said"],
        accepted_at=datetime.fromisoformat(item["accepted_at"]),
        spoken_s=item["spoken_s"],
    )
    # Только проверяемая просьба: чужая ошибка повтора адреса не маскирует её вклад.
    verdict = BrigadeWorkCriterion().evaluate(
        EvalContext(
            {},
            {},
            [],
            journal.calls,
            {"weights": {"brigade_work": 1.0}},
            scenario_events=projected,
        )
    )
    shaped = world({UUID(event["id"]): event}, journal, future)
    surprise_id = event["branches"]["surprise"]["line"]["id"]
    surprise = [line for line in shaped.lines if line.message["id"] == surprise_id]
    return journal, event, projected, rows, outcome, verdict, surprise


@pytest.mark.parametrize("commit_kind", ["brigade_reply", "brigade_said"])
def test_free_ambulance_news_commits_and_prevents_surprise(
    database_config, database_url, request, monkeypatch, commit_kind
):
    # Исходный пользовательский сценарий, без изменения плана, эталона или часов БД.
    monkeypatch.setitem(final.SEATS, CODE, ("MOSLIFT", "trainee03"))
    seed_training(database_url)
    shift = open_shift(database_config, database_url, request, CODE)
    shift.open()
    shift.accept()
    shift.brief()
    readback = shift.hear(["event:readback"], 4)
    shift.reply(readback, "fix")
    shift.status("responding", "Механик выехал")
    shift.hear(["message:arrival"], 7)
    shift.status("arrived", "Механик на месте")
    question = shift.hear(["event:ambulance"], 4)
    delivery_id = question["delivery"]["delivery_id"]
    journal, event, _, _ = snapshot(shift)
    assert event["expect"][0]["phone_exts"] == ["103", "112"]
    # Worker переносит только свой тик. HTTP-факт должен наступить после срабатывания:
    # ждём не минутный deadline, а максимум оставшиеся 3 с реального trigger.after_s.
    fired = journal.firings[UUID(event["id"])].fired_at
    remaining = max(0.0, (fired - datetime.now(UTC)).total_seconds())
    assert remaining < 4.1
    if remaining:
        time.sleep(remaining + 0.02)

    fake = FakeSTT(NEWS, 0.9)
    shift.client.app.state.voice_report_stt = fake

    def recognize(text: str, delivery: str | None = delivery_id) -> dict:
        fake.result = Recognition(text, 0.9)
        response = voice_reply(shift.client, shift.headers, shift.call_id, delivery)
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["text"] == text
        return body

    # Смысл узнаётся, но без настоящего набора 103 это лишь заявление, а не вызов.
    assert recognize(NEWS)["option_key"] == "already"
    shift.send("brigade_said", {"call_id": shift.call_id, "text": NEWS})
    *_, no_call, no_call_score, _ = domain_state(shift)
    assert no_call.news != "told"
    assert no_call.branch == "missed"
    assert no_call_score.score == 0.0

    shift.dial("103")
    # Пришедшая после звонка фраза о другой службе и вопрос не превращаются в весть.
    for text in ("Полицию уже вызвал, едут", "Уже вызвал, едут?"):
        assert recognize(text)["option_key"] is None
        shift.send("brigade_said", {"call_id": shift.call_id, "text": text})
        _, _, _, _, negative, negative_score, surprise = domain_state(shift)
        assert negative.branch == "met"
        assert negative.news == "untold"
        assert negative_score.score == pytest.approx(0.9)
        assert len(surprise) == 1  # положительная проверка чувствительности расписания

    recognized = recognize(NEWS)
    assert recognized["option_key"] == "already"
    payload = {"call_id": shift.call_id, "text": recognized["text"]}
    if commit_kind == "brigade_reply":
        payload.update(
            delivery_id=delivery_id,
            option_key=recognized["option_key"],
            mode="voice",
            loudness=recognized["loudness"],
        )
    else:
        # Свободная фраза без delivery_id: HTTP возвращает текст, не кнопку.
        free = recognize(NEWS, None)
        assert free["option_key"] is None
        payload["text"] = free["text"]
    shift.send(commit_kind, payload)

    journal, event, projected, rows, outcome, verdict, surprise = domain_state(shift)
    called_at = next(
        datetime.fromisoformat(call["started_at"])
        for call in journal.calls
        if call["phone_ext"] == "103" and call["brigade_id"] is None
    )
    committed = [
        row for row in rows if row[0] == commit_kind and row[1] == payload and row[2] >= called_at
    ]
    assert len(committed) == 1
    at = committed[0][2]
    line_id = UUID(event["line"]["id"])
    brigade_id = UUID(event["brigade_id"])
    utterances = (
        journal.replies[line_id] if commit_kind == "brigade_reply" else journal.said[brigade_id]
    )
    assert any(
        item.get("text") == NEWS and datetime.fromisoformat(item["at"]) == at for item in utterances
    )
    projected_utterances = (
        projected[0]["replies"] if commit_kind == "brigade_reply" else projected[0]["said"]
    )
    assert any(
        item.get("text") == NEWS and datetime.fromisoformat(item["at"]) == at
        for item in projected_utterances
    )
    assert outcome.branch == "met"
    assert outcome.news == "told"
    assert outcome.news_at == at
    assert outcome.news_by is not None and at <= outcome.news_by
    assert verdict.score == 1.0
    assert not verdict.critical
    assert verdict.weight == 1.0
    assert surprise == []
    # Проверяем также реальную выдачу worker через HTTP-проекцию после приезда скорой.
    worker_tick(database_url, outcome.news_by + timedelta(seconds=1))
    surprise_id = event["branches"]["surprise"]["line"]["id"]
    assert surprise_id not in {item["delivery"]["message"]["id"] for item in shift.messages()}
    assert fake.calls == (4 if commit_kind == "brigade_reply" else 5)
