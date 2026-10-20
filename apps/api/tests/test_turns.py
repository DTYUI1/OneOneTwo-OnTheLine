"""Очередь реплик бригады (`app.api.training.turns`): вопрос ждёт ответа, доклад — «Принял»."""

import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import UUID

import pytest
from app.api.training.scenario_events import turns_of
from app.api.training.turns import ANSWER_PAUSE, CONFIRM_ASK, Turn, asks_confirmation, quiet
from app.core.config import ROOT

CASES = ROOT / "apps/web/src/arm/softphone/brigade/confirmRequest.cases.json"
CREW = UUID("00000000-0000-4000-8000-000000000001")
T0 = datetime(2026, 10, 17, 12, 0, tzinfo=UTC)


def at(seconds: float) -> datetime:
    return T0 + timedelta(seconds=seconds)


@pytest.mark.parametrize(
    "case", json.loads(CASES.read_text(encoding="utf-8"))["cases"], ids=lambda case: case["what"]
)
def test_confirm_request_rule_matches_softphone_table(case):
    """Та же таблица, что у vitest окна телефона: правило «Как приняли?» не расходится."""
    assert asks_confirmation(case["inbound"], case["question"], case["answer"]) is case["asks"]


def test_unheard_turn_blocks_the_next_line():
    gate = quiet([Turn(CREW, None, None)])[CREW]
    assert gate.blocked and gate.ready(at(5)) is None


def test_answered_turn_releases_at_the_answer():
    gate = quiet([Turn(CREW, at(10), at(13))])[CREW]
    assert gate.ready(at(11)) == at(13)
    assert gate.ready(at(20)) == at(20)


def test_silent_dispatcher_releases_after_the_pause():
    gate = quiet([Turn(CREW, at(10), None)])[CREW]
    assert gate.ready(at(11)) == at(10) + ANSWER_PAUSE
    # Ответ после паузы бригаду уже не держит.
    late = quiet([Turn(CREW, at(10), at(30))])[CREW]
    assert late.ready(at(11)) == at(10) + ANSWER_PAUSE


def test_latest_turn_wins():
    gate = quiet([Turn(CREW, at(10), at(12)), Turn(CREW, at(40), None)])[CREW]
    assert gate.ready(at(41)) == at(40) + ANSWER_PAUSE


def test_report_pause_counts_from_the_end_of_confirm_request():
    """После доклада окно телефона ещё спрашивает «Как приняли?»: пауза — от конца вопроса."""
    gate = quiet([Turn(CREW, at(10), None, ANSWER_PAUSE + CONFIRM_ASK)])[CREW]
    assert gate.ready(at(11)) == at(10) + ANSWER_PAUSE + CONFIRM_ASK


# --- Фраза диспетчера, сказанная во время реплики, — ответ на неё (HQ-028) -------------------

CALL = UUID("00000000-0000-4000-8000-0000000000c1")
REPORT = UUID("00000000-0000-4000-8000-0000000000d1")
BEFORE = UUID("00000000-0000-4000-8000-0000000000d2")


def delivery(delivery_id: UUID, delivered: float, duration_ms: int | None = None):
    audio = {"duration_ms": duration_ms} if duration_ms is not None else None
    return SimpleNamespace(
        id=delivery_id,
        call_id=CALL,
        brigade_id=CREW,
        message_id=delivery_id,
        message_version=1,
        delivered_at=at(delivered),
        message={"id": str(delivery_id), "version": 1, "text": "Доклад", "audio": audio},
    )


def said(seconds: float):
    return SimpleNamespace(
        type="brigade_said",
        server_ts=at(seconds),
        payload={"call_id": str(CALL), "text": "Скорую уже вызвал, едет."},
    )


def report_turn(talk, others=(), presented=None):
    inbound = SimpleNamespace(
        id=CALL, direction="inbound", answered_at=at(5), ended_at=None, started_at=at(3)
    )
    deliveries = [delivery(REPORT, 10, duration_ms=6000), *others]
    first = {REPORT: at(20), **(presented or {})}
    [turn] = [
        item for item in turns_of(deliveries, first, [inbound], talk, []) if item.heard == at(20)
    ]
    return turn


def test_phrase_during_the_line_answers_it_when_the_line_ends():
    """«Скорую уже вызвал» во время тревоги: бригада не ждёт ответа ещё 8 с и не говорит
    доклад поверх «Как приняли?» — ответ засчитан к концу её реплики."""
    assert report_turn([said(17)]).answered == at(20)
    assert report_turn([said(22)]).answered == at(22)


def test_phrase_begun_in_the_last_second_answers_the_line():
    """Окно телефона пишет ответ уже за секунду до конца реплики (HQ-052): короткое «Принял»,
    ушедшее ещё до её конца, засчитано ответом к концу реплики, а не потеряно."""
    assert report_turn([said(19.5)]).answered == at(20)


def test_confirm_after_early_recording_answers_confirm_request():
    """Запись, начатая в последнюю секунду доклада, не гаснет на «Как приняли?» (HQ-052): её
    «Принял» уходит после конца записи, уже во время или после вопроса, — и засчитан ответом."""
    confirmed = SimpleNamespace(
        type="report_confirmed",
        server_ts=at(21.5),
        payload={"call_id": str(CALL), "delivery_id": str(REPORT), "text": "Принял"},
    )
    assert report_turn([confirmed]).answered == at(21.5)
    assert report_turn([said(20.4)]).answered == at(20.4)


def test_phrase_before_the_line_is_not_its_answer():
    # Реплика длиной 6 с началась в 14 с: «Принял» в 12 с — ответ на прошлую.
    assert report_turn([said(12)]).answered is None
    # Прошлая реплика разговора кончилась в 16 с — новая звучит после неё.
    earlier = delivery(BEFORE, 4)
    assert report_turn([said(15)], [earlier], {BEFORE: at(16)}).answered is None
    assert report_turn([said(17)], [earlier], {BEFORE: at(16)}).answered == at(20)
