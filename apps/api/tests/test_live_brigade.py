"""DT-10, «живая бригада»: когда срабатывают события и что меняется в мире (без БД)."""

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from app.api.training.content import event_lines
from app.api.training.gating import ScheduledReport
from app.api.training.scenario_events import (
    Firing,
    Journal,
    alarm_at,
    alarm_holds_cards,
    alarm_pending,
    apply_world,
    carried_events,
    cast_event,
    due_events,
    last_contact,
    on_line,
    reply_options,
    world,
)
from app.api.training.turns import Turn
from app.worker.training import delivery_order
from fastapi import HTTPException

T0 = datetime(2026, 10, 8, 9, 0, tzinfo=UTC)
CREW = UUID("00000000-0000-4000-8000-000000000001")
TARGET = UUID("00000000-0000-4000-8000-000000000002")
OTHER = UUID("00000000-0000-4000-8000-000000000003")
OTHER_TARGET = UUID("00000000-0000-4000-8000-000000000004")
DEPARTURE = UUID("00000000-0000-4000-8000-0000000000a1")
ARRIVAL = UUID("00000000-0000-4000-8000-0000000000a2")
WORKS = UUID("00000000-0000-4000-8000-0000000000a3")
COMPLETION = UUID("00000000-0000-4000-8000-0000000000a4")
CLARIFY = UUID("00000000-0000-4000-8000-0000000000e1")
REQUEST = UUID("00000000-0000-4000-8000-0000000000e2")
NUDGE = UUID("00000000-0000-4000-8000-0000000000e3")
SILENCE = UUID("00000000-0000-4000-8000-0000000000e4")
ALARM = UUID("00000000-0000-4000-8000-0000000000e5")
READBACK = UUID("00000000-0000-4000-8000-0000000000e6")


def at(seconds: float) -> datetime:
    return T0 + timedelta(seconds=seconds)


def line(number: int, text: str) -> dict:
    return {
        "id": f"00000000-0000-4000-8000-0000000001{number:02d}",
        "version": 1,
        "text": text,
        "audio": None,
    }


def event(event_id: UUID, kind: str, trigger: dict, expect: list[dict], **extra) -> dict:
    return {
        "id": str(event_id),
        "version": 1,
        "kind": kind,
        "actor": "brigade",
        "brigade_id": str(CREW),
        "call_target_id": str(TARGET),
        "channel": "brigade_call",
        "priority": extra.pop("priority", "normal"),
        "trigger": trigger,
        "line": extra.pop("line", None),
        "expect": expect,
        "branches": extra.pop("branches", {}),
        "review": {"label": kind, "critical": extra.pop("critical", False)},
        "injectable": False,
        **extra,
    }


CLARIFY_EVENT = event(
    CLARIFY,
    "clarify",
    {"on": "message", "message_id": str(ARRIVAL), "after_s": 2},
    [{"action": "reply", "option_key": "floor_9", "within_s": 40}],
    line=line(1, "На каком этаже квартира сто пятнадцать?"),
    reply_options=[
        {"key": "floor_9", "label": "Девятый этаж"},
        {"key": "unknown", "label": "Не знаю — ищите по подъездам"},
    ],
    branches={
        "met": {"line": line(2, "Понял, девятый. Поднимаемся."), "effects": []},
        "wrong": {
            "line": line(3, "Понял. Будем искать по подъездам."),
            "effects": [{"delay": str(WORKS), "by_s": 60}],
        },
        "missed": {"line": None, "effects": [{"delay": str(WORKS), "by_s": 60}]},
    },
)
REQUEST_EVENT = event(
    REQUEST,
    "request_service",
    {"on": "message", "message_id": str(WORKS), "after_s": 3},
    [{"action": "call_service", "phone_exts": ["103", "112"], "within_s": 60}],
    line=line(4, "Мужчина без сознания. Нужна скорая!"),
)
NUDGE_EVENT = event(
    NUDGE,
    "request_service",
    {"on": "event", "event_id": str(REQUEST), "branch": "missed", "after_s": 0},
    [{"action": "call_service", "phone_exts": ["103", "112"], "within_s": 60}],
    line=line(5, "Диспетчер, скорая будет?"),
    branches={
        "missed": {
            "line": None,
            "effects": [{"replace": str(COMPLETION), "with": line(6, "Скорой нет, ждём.")}],
        }
    },
)
SILENCE_EVENT = event(
    SILENCE,
    "silence",
    {"on": "no_contact", "state": "working", "silent_s": 40},
    [{"action": "call_brigade", "within_s": 60}],
    branches={
        "met": {"line": line(7, "Работы идут, проливаем."), "effects": []},
        "missed": {"line": None, "effects": [{"delay": str(COMPLETION), "by_s": 45}]},
    },
)
ALARM_EVENT = event(
    ALARM,
    "alarm",
    {"on": "state", "state": "working", "after_s": 20},
    [
        {"action": "answer_call", "within_s": 15},
        {"action": "call_service", "phone_exts": ["103", "112"], "within_s": 60},
    ],
    line=line(8, "Тревога! Боец упал в пролёт лестницы."),
    priority="alarm",
    critical=True,
)
EVENTS = [CLARIFY_EVENT, REQUEST_EVENT, NUDGE_EVENT, SILENCE_EVENT, ALARM_EVENT]
BY_ID = {UUID(item["id"]): item for item in EVENTS}


def call(
    started: float,
    *,
    ext: str = "201",
    brigade: UUID | None = CREW,
    answered: float | None = None,
    ended: float | None = None,
    direction: str = "outbound",
) -> dict:
    def iso(value: float | None) -> str | None:
        return at(value).isoformat() if value is not None else None

    return {
        "id": f"call-{started}",
        "service_id": "101" if brigade else ext,
        "phone_ext": ext,
        "brigade_id": str(brigade) if brigade else None,
        "direction": direction,
        "refusal": None,
        "started_at": iso(started),
        "answered_at": iso(answered),
        "ended_at": iso(ended),
        "transcript": None,
    }


def journal(
    *,
    statuses: list[tuple[str, float]] = (),
    presented: dict[UUID, float] | None = None,
    calls: list[dict] = (),
    firings: dict[UUID, float] | None = None,
    replies: dict[UUID, list[tuple[float, str]]] | None = None,
    delivered: set[UUID] = frozenset(),
) -> Journal:
    presented = presented or {}
    return Journal(
        statuses=[(state, at(seconds)) for state, seconds in statuses],
        presented={key: at(value) for key, value in presented.items()},
        delivered={key: CREW for key in delivered | set(presented)},
        heard_from={CREW: [at(value) for value in presented.values()]},
        replies={
            key: [{"at": at(s).isoformat(), "option_key": k} for s, k in values]
            for key, values in (replies or {}).items()
        },
        calls=list(calls),
        firings={key: Firing(key, at(value), "plan") for key, value in (firings or {}).items()},
        # Вводная — в первом отвеченном разговоре с бригадой (GP-05).
        briefed={CREW: min(datetime.fromisoformat(item["answered_at"]) for item in answered)}
        if (answered := [c for c in calls if c["brigade_id"] and c["answered_at"]])
        else {},
    )


DISPATCHED = [call(0, answered=1, ended=5)]


def report(message_id: UUID, ready: float, *, issued: bool = False) -> ScheduledReport:
    return ScheduledReport(
        planned={
            "message": {"id": str(message_id), "version": 1, "text": "доклад", "audio": None},
            "brigade_id": str(CREW),
            "call_target_id": str(TARGET),
            "available_after_s": 6,
        },
        identity=(message_id, 1),
        brigade_id=CREW,
        target_id=TARGET,
        issued=issued,
        waiting_started_at=at(0),
        ready_at=at(ready),
    )


# --- Когда срабатывает ---------------------------------------------------------------------


def test_message_trigger_fires_after_report_presented():
    state = journal(presented={ARRIVAL: 30}, calls=DISPATCHED)
    assert due_events(EVENTS, state, {CREW}, at(31)) == []
    assert due_events(EVENTS, state, {CREW}, at(33)) == [(CLARIFY_EVENT, at(32))]


def test_fired_event_does_not_fire_twice():
    state = journal(presented={ARRIVAL: 30}, calls=DISPATCHED, firings={CLARIFY: 32})
    assert due_events(EVENTS, state, {CREW}, at(40)) == []


def test_state_trigger_counts_from_later_of_status_and_contact():
    state = journal(statuses=[("working", 100)], calls=[call(0, answered=150, ended=160)])
    assert due_events([ALARM_EVENT], state, {CREW}, at(160)) == []
    assert due_events([ALARM_EVENT], state, {CREW}, at(170)) == [(ALARM_EVENT, at(170))]


def test_state_trigger_needs_brigade_on_line():
    state = journal(statuses=[("working", 100)])
    assert due_events([ALARM_EVENT], state, {CREW}, at(500)) == []


@pytest.mark.parametrize(
    "talk",
    [
        call(110, answered=111),  # идёт разговор с бригадой
        call(110),  # диспетчер набирает бригаду
        call(110, direction="inbound"),  # бригада звонит с докладом
    ],
)
def test_alarm_does_not_break_into_a_call_with_its_brigade(talk):
    # Решение 15.10: тревога не врывается в разговор, а ждёт отбоя.
    state = journal(statuses=[("working", 100)], calls=[*DISPATCHED, talk])
    assert due_events([ALARM_EVENT], state, {CREW}, at(400)) == []


def test_alarm_rings_ten_seconds_after_the_call():
    talk = call(110, answered=111, ended=125)
    state = journal(statuses=[("working", 100)], calls=[*DISPATCHED, talk])
    # По плану — 120 с (работы + 20 с), но разговор кончился в 125 с: тревога в 135 с,
    # и сроки ответа и скорой — от неё.
    assert due_events([ALARM_EVENT], state, {CREW}, at(134)) == []
    assert due_events([ALARM_EVENT], state, {CREW}, at(136)) == [(ALARM_EVENT, at(135))]


def test_call_with_other_service_does_not_delay_alarm():
    calls = [*DISPATCHED, call(110, ext="103", brigade=None, answered=111)]
    state = journal(statuses=[("working", 100)], calls=calls)
    assert due_events([ALARM_EVENT], state, {CREW}, at(121)) == [(ALARM_EVENT, at(120))]


def test_alarm_at_for_inject():
    assert alarm_at(CREW, journal(calls=[call(0, answered=1)]), at(50)) is None
    assert alarm_at(CREW, journal(calls=DISPATCHED), at(10)) == at(15)
    assert alarm_at(CREW, journal(calls=DISPATCHED), at(50)) == at(50)


ALARM_LINE = UUID(ALARM_EVENT["line"]["id"])


@pytest.mark.parametrize(
    ("calls", "presented", "now", "holds"),
    [
        (DISPATCHED, None, 210, True),  # тревога звонит, не взята
        (DISPATCHED, None, 261, False),  # не взята дольше срока — карточки идут дальше
        ([*DISPATCHED, call(203, answered=204)], 205, 300, True),  # тревожный разговор
        ([*DISPATCHED, call(203, answered=204, ended=230)], 205, 239, True),  # 10 с паузы
        ([*DISPATCHED, call(203, answered=204, ended=230)], 205, 241, False),
        # Позже снова звонят бригаде за докладом — это уже не тревога.
        (
            [*DISPATCHED, call(203, answered=204, ended=230), call(400, answered=401)],
            205,
            410,
            False,
        ),
    ],
)
def test_alarm_holds_new_cards(calls, presented, now, holds):
    state = journal(
        calls=calls,
        firings={ALARM: 200},
        presented={ALARM_LINE: presented} if presented is not None else None,
    )
    assert alarm_holds_cards([ALARM_EVENT], state, at(now)) is holds


def test_other_events_do_not_hold_new_cards():
    state = journal(calls=DISPATCHED, firings={REQUEST: 50})
    assert not alarm_holds_cards([REQUEST_EVENT], state, at(55))


def test_chained_event_fires_after_parent_missed():
    request_line = UUID(REQUEST_EVENT["line"]["id"])
    state = journal(
        presented={WORKS: 50, request_line: 55}, calls=DISPATCHED, firings={REQUEST: 53}
    )
    chain = [REQUEST_EVENT, NUDGE_EVENT]
    assert due_events(chain, state, {CREW}, at(112)) == []
    assert due_events(chain, state, {CREW}, at(113)) == [(NUDGE_EVENT, at(113))]


def test_chained_event_does_not_fire_when_parent_met():
    calls = [*DISPATCHED, call(70, ext="103", brigade=None)]
    state = journal(calls=calls, firings={REQUEST: 53}, presented={WORKS: 50})
    assert due_events([REQUEST_EVENT, NUDGE_EVENT], state, {CREW}, at(200)) == []


def test_silence_fires_after_silent_s_without_contact():
    state = journal(
        statuses=[("working", 100)],
        presented={WORKS: 95},
        calls=[call(0, answered=1, ended=110)],
    )
    assert due_events([SILENCE_EVENT], state, {CREW}, at(149)) == []
    assert due_events([SILENCE_EVENT], state, {CREW}, at(151)) == [(SILENCE_EVENT, at(150))]


@pytest.mark.parametrize(
    "calls",
    [
        [call(0, answered=1)],  # идёт разговор с бригадой
        [call(0, answered=1, ended=5), call(120, direction="inbound")],  # бригада звонит
    ],
)
def test_silence_waits_while_brigade_on_line(calls):
    state = journal(statuses=[("working", 100)], calls=calls)
    assert due_events([SILENCE_EVENT], state, {CREW}, at(400)) == []


def test_silence_of_finished_brigade_is_not_an_event():
    state = journal(statuses=[("working", 100)], calls=DISPATCHED)
    assert due_events([SILENCE_EVENT], state, set(), at(400)) == []


def test_last_contact_is_latest_heard_or_ended_call():
    state = journal(presented={WORKS: 95}, calls=[call(0, answered=1, ended=110)])
    assert last_contact(CREW, state) == at(110)
    assert last_contact(OTHER, state) is None


def test_on_line_while_call_is_open():
    assert on_line(CREW, journal(calls=[call(0, answered=1)]))
    assert on_line(CREW, journal(calls=[call(120, direction="inbound")]))
    assert not on_line(CREW, journal(calls=[call(0, answered=1, ended=110)]))


# --- Что меняется в мире ---------------------------------------------------------------------


def clarify_journal(replies=None, presented_line=33.0):
    presented = {ARRIVAL: 30}
    if presented_line is not None:
        presented[UUID(CLARIFY_EVENT["line"]["id"])] = presented_line
    return journal(presented=presented, calls=DISPATCHED, firings={CLARIFY: 32}, replies=replies)


def test_pending_event_holds_report_until_deadline():
    state = world(BY_ID, clarify_journal(), at(40))
    # Срок ответа — от того, как вопрос услышали (33 с), а не от срабатывания (32 с).
    assert state.holds[WORKS] == at(73)
    [works, question] = apply_world([report(WORKS, 38)], state, set())
    assert works.ready_at == at(73)
    assert question.identity == (UUID(CLARIFY_EVENT["line"]["id"]), 1)
    assert question.ready_at == at(32)


def test_met_releases_report_and_brigade_answers():
    replies = {UUID(CLARIFY_EVENT["line"]["id"]): [(45, "floor_9")]}
    state = world(BY_ID, clarify_journal(replies), at(46))
    works, _, answer = apply_world([report(WORKS, 38)], state, set())
    assert works.ready_at == at(45)
    assert answer.planned["message"]["text"] == "Понял, девятый. Поднимаемся."
    assert answer.ready_at == at(45)


def test_wrong_answer_delays_report_and_brigade_says_so():
    replies = {UUID(CLARIFY_EVENT["line"]["id"]): [(45, "unknown")]}
    state = world(BY_ID, clarify_journal(replies), at(46))
    # Задержка ветки не отодвигает доклад дальше 40 с от начала ожидания (здесь — at(0),
    # GP-12, gating.MAX_REPORT_WAIT); раньше исхода события доклад тоже не приходит.
    works, _, answer = apply_world([report(WORKS, 38)], state, set())
    assert works.ready_at == at(45)
    assert answer.planned["message"]["text"] == "Понял. Будем искать по подъездам."


def test_missed_delays_report_without_answer():
    state = world(BY_ID, clarify_journal(), at(80))
    # Задержка ветки не отодвигает доклад дальше 40 с от начала ожидания (здесь — at(0),
    # GP-12, gating.MAX_REPORT_WAIT); раньше исхода события доклад тоже не приходит.
    works, _ = apply_world([report(WORKS, 38)], state, set())
    assert works.ready_at == at(73)


def test_unheard_question_gets_no_answer_line():
    state = world(BY_ID, clarify_journal(presented_line=None), at(80))
    assert [item.message["id"] for item in state.lines] == [CLARIFY_EVENT["line"]["id"]]


def test_missed_nudge_replaces_report_but_late_call_restores_it():
    nudge_line = UUID(NUDGE_EVENT["line"]["id"])
    base = {
        "presented": {WORKS: 50, nudge_line: 115},
        "firings": {REQUEST: 53, NUDGE: 113},
    }
    missed = world(BY_ID, journal(calls=DISPATCHED, **base), at(180))
    [completion, *_] = apply_world([report(COMPLETION, 150)], missed, set())
    assert completion.planned["message"]["text"] == "Скорой нет, ждём."
    assert completion.planned["message"]["version"] == 1
    assert completion.identity == (COMPLETION, 1)

    calls = [*DISPATCHED, call(175, ext="103", brigade=None)]
    late = world(BY_ID, journal(calls=calls, **base), at(180))
    [completion, *_] = apply_world([report(COMPLETION, 150)], late, set())
    assert completion.planned["message"]["text"] == "доклад"


def test_silence_met_line_goes_into_the_call():
    calls = [call(0, answered=1, ended=110), call(160, answered=162)]
    state = journal(calls=calls, firings={SILENCE: 150}, statuses=[("working", 100)])
    lines = world(BY_ID, state, at(163)).lines
    assert [(item.message["text"], item.ready_at) for item in lines] == [
        ("Работы идут, проливаем.", at(162))
    ]


def test_silence_missed_delays_completion():
    state = journal(calls=DISPATCHED, firings={SILENCE: 150})
    # Задержка ветки не отодвигает доклад дальше 40 с от начала ожидания (здесь — at(0),
    # GP-12, gating.MAX_REPORT_WAIT); раньше исхода события доклад тоже не приходит.
    [completion] = apply_world([report(COMPLETION, 190)], world(BY_ID, state, at(211)), set())
    assert completion.ready_at == at(210)


def test_issued_report_is_not_touched():
    state = world(BY_ID, clarify_journal(), at(80))
    [works, _] = apply_world([report(WORKS, 38, issued=True)], state, set())
    assert works.ready_at == at(38)


def test_alarm_rings_as_alarm_until_delivered():
    state = journal(calls=DISPATCHED, firings={ALARM: 120})
    assert alarm_pending(BY_ID, state) == {CREW}
    heard = journal(
        calls=DISPATCHED, firings={ALARM: 120}, delivered={UUID(ALARM_EVENT["line"]["id"])}
    )
    assert alarm_pending(BY_ID, heard) == set()


def test_event_goes_to_brigade_playing_the_role():
    moved = cast_event(ALARM_EVENT, {CREW: (OTHER, OTHER_TARGET)})
    assert moved["brigade_id"] == str(OTHER)
    assert moved["call_target_id"] == str(OTHER_TARGET)
    assert cast_event(ALARM_EVENT, {}) is ALARM_EVENT


def test_reply_options_only_for_lines_with_options():
    assert reply_options(EVENTS) == {
        UUID(CLARIFY_EVENT["line"]["id"]): CLARIFY_EVENT["reply_options"]
    }


# --- Повтор адреса с ошибкой ---------------------------------------------------------------


WRONG_PLACE = {
    "line": None,
    "effects": [
        {"replace": str(ARRIVAL), "with": line(12, "Мы на Бескудниковском переулке!")},
        {"delay": str(ARRIVAL), "by_s": 45},
    ],
}
READBACK_EVENT = event(
    READBACK,
    "readback_error",
    {"on": "message", "message_id": str(DEPARTURE), "after_s": 1},
    [{"action": "correct_readback", "option_key": "fix", "within_s": 40}],
    line=line(10, "Как поняли? Бескудниковский переулок, двадцать четыре, выезжаем!"),
    reply_options=[
        {"key": "fix", "label": "Поправка по адресу: Бескудниковский бульвар, 24"},
        {"key": "ok", "label": "Понял"},
    ],
    branches={
        "met": {"line": line(11, "Понял, Бескудниковский бульвар, едем."), "effects": []},
        "wrong": WRONG_PLACE,
        "missed": WRONG_PLACE,
    },
    critical=True,
)
READBACK_LINE = UUID(READBACK_EVENT["line"]["id"])
READBACK_BY_ID = {READBACK: READBACK_EVENT}


def readback_journal(replies=(), calls=()):
    return journal(
        presented={DEPARTURE: 10, READBACK_LINE: 11},
        calls=[call(0, answered=1), *calls],
        firings={READBACK: 11},
        replies={READBACK_LINE: list(replies)},
    )


def test_readback_fires_after_departure_report():
    state = journal(presented={DEPARTURE: 10}, calls=[call(0, answered=1)])
    assert due_events([READBACK_EVENT], state, {CREW}, at(10.5)) == []
    assert due_events([READBACK_EVENT], state, {CREW}, at(12)) == [(READBACK_EVENT, at(11))]


def test_readback_holds_arrival_while_crew_is_on_the_way():
    state = world(READBACK_BY_ID, readback_journal(), at(20))
    [arrival, question] = apply_world([report(ARRIVAL, 18)], state, set())
    assert arrival.ready_at == at(51)
    assert question.planned["message"]["text"].startswith("Как поняли?")


def test_readback_fixed_in_same_conversation_releases_arrival():
    state = world(READBACK_BY_ID, readback_journal([(16, "fix")]), at(17))
    arrival, _, answer = apply_world([report(ARRIVAL, 18)], state, set())
    assert arrival.ready_at == at(18)
    assert arrival.planned["message"]["text"] == "доклад"
    assert answer.planned["message"]["text"] == "Понял, Бескудниковский бульвар, едем."
    assert answer.ready_at == at(16)


def test_readback_fixed_by_calling_crew_on_the_way():
    calls = [call(30, answered=32)]
    state = world(READBACK_BY_ID, readback_journal(calls=calls), at(33))
    arrival, _, answer = apply_world([report(ARRIVAL, 18)], state, set())
    assert arrival.ready_at == at(32)
    assert (answer.planned["message"]["text"], answer.ready_at) == (
        "Понял, Бескудниковский бульвар, едем.",
        at(32),
    )


@pytest.mark.parametrize("replies", [[(16, "ok")], []])
def test_readback_not_fixed_crew_arrives_at_wrong_place(replies):
    journal_ = readback_journal(replies)
    # «Понял» — ещё не ветка: расчёт в пути, можно перезвонить.
    early = world(READBACK_BY_ID, journal_, at(30))
    assert apply_world([report(ARRIVAL, 18)], early, set())[0].ready_at == at(51)
    state = world(READBACK_BY_ID, journal_, at(52))
    # Задержка ветки не отодвигает доклад дальше 40 с от начала ожидания (здесь — at(0),
    # GP-12, gating.MAX_REPORT_WAIT); раньше исхода события доклад тоже не приходит.
    [arrival, _] = apply_world([report(ARRIVAL, 18)], state, set())
    assert arrival.ready_at == at(51)
    assert arrival.planned["message"]["text"] == "Мы на Бескудниковском переулке!"
    assert arrival.identity == (ARRIVAL, 1)


def test_readback_options_go_to_the_question():
    assert reply_options([READBACK_EVENT]) == {READBACK_LINE: READBACK_EVENT["reply_options"]}


def test_readback_correction_needs_its_option():
    broken = {**READBACK_EVENT, "reply_options": [{"key": "ok", "label": "Понял"}]}
    messages = {str(DEPARTURE), *MESSAGES}
    assert len(event_lines([READBACK_EVENT], messages)) == 4
    with pytest.raises(HTTPException):
        event_lines([broken], messages)


# --- Проверка плана --------------------------------------------------------------------------


MESSAGES = {str(ARRIVAL), str(WORKS), str(COMPLETION)}


def test_plan_events_are_valid():
    lines = event_lines(EVENTS, MESSAGES)
    assert len(lines) == 8


@pytest.mark.parametrize(
    "broken",
    [
        {**CLARIFY_EVENT, "trigger": {"on": "message", "message_id": str(OTHER), "after_s": 0}},
        {**NUDGE_EVENT, "trigger": {**NUDGE_EVENT["trigger"], "event_id": str(NUDGE)}},
        {**CLARIFY_EVENT, "reply_options": [{"key": "unknown", "label": "Не знаю"}]},
        {**CLARIFY_EVENT, "line": {**CLARIFY_EVENT["line"], "id": str(WORKS)}},
        {
            **SILENCE_EVENT,
            "branches": {"missed": {"line": None, "effects": [{"delay": str(OTHER), "by_s": 5}]}},
        },
    ],
)
def test_broken_links_are_rejected(broken):
    events = [broken if item["id"] == broken["id"] else item for item in EVENTS]
    with pytest.raises(HTTPException) as error:
        event_lines(events, MESSAGES)
    assert error.value.status_code == 422


def test_duplicate_line_ids_are_rejected():
    copy = {**ALARM_EVENT, "id": str(OTHER)}
    with pytest.raises(HTTPException):
        event_lines([*EVENTS, copy], MESSAGES)


# --- Связность мира: очередь реплик, фаза события, повтор адреса в докладе (17.10) -----------


@pytest.mark.parametrize(
    ("turn", "ready"),
    [
        (Turn(CREW, None, None), None),  # вопрос выдан, но не прозвучал — бригада молчит
        (Turn(CREW, at(20), None), at(28)),  # прозвучал, ответа нет — пауза 8 с
        (Turn(CREW, at(20), at(22)), at(22)),  # диспетчер ответил — говорит дальше
    ],
)
def test_brigade_does_not_talk_over_its_question(turn, ready):
    state = replace(journal(calls=DISPATCHED), turns=[turn])
    [arrival] = apply_world([report(ARRIVAL, 18)], world({}, state, at(30)), set())
    assert arrival.ready_at == ready


def test_new_question_waits_for_the_previous_one():
    """Второй вопрос не звучит поверх первого: срок события — от того, когда спросили."""
    state = replace(
        journal(presented={ARRIVAL: 30}, calls=DISPATCHED), turns=[Turn(CREW, at(31), None)]
    )
    assert due_events([CLARIFY_EVENT], state, {CREW}, at(35)) == []
    assert due_events([CLARIFY_EVENT], state, {CREW}, at(40)) == [(CLARIFY_EVENT, at(39))]


def test_event_after_report_sounds_before_the_next_report():
    """Вопрос, заданный после прибытия, не опаздывает за следующий доклад."""
    state = journal(presented={ARRIVAL: 30}, calls=DISPATCHED)
    held = world(BY_ID, state, at(31), following={ARRIVAL: WORKS})
    assert held.holds[WORKS] == at(32)
    [works] = apply_world([report(WORKS, 31)], held, set())
    assert works.ready_at == at(32)


def test_departure_report_carries_the_readback():
    """«Как поняли? …, выезжаем!» — это и есть доклад о выезде, а не реплика после него."""
    departure = {**report(DEPARTURE, 5).planned, "justifies_state": "responding"}
    carried = carried_events([READBACK_EVENT], [departure])
    assert carried == {READBACK: DEPARTURE}
    state = journal(calls=[call(0, answered=1)])
    assert due_events([READBACK_EVENT], state, {CREW}, at(5), carried) == []
    said = journal(presented={DEPARTURE: 10}, calls=[call(0, answered=1)])
    assert due_events([READBACK_EVENT], said, {CREW}, at(10), carried) == [(READBACK_EVENT, at(10))]
    fired = replace(said, firings={READBACK: Firing(READBACK, at(10), "plan")})
    shaped = world(READBACK_BY_ID, fired, at(11), carried)
    assert [item.message["id"] for item in shaped.lines] == []
    [spoken] = apply_world([report(DEPARTURE, 5)], shaped, set())
    assert spoken.planned["message"]["text"].startswith("Как поняли?")
    assert spoken.planned["question"] is True


# --- Поздний ответ этапа позже текущего ждёт доклада этого этапа (HQ-028) -------------------

ENTRANCE = UUID("00000000-0000-4000-8000-0000000000e7")
ENTRANCE_EVENT = event(
    ENTRANCE,
    "clarify",
    {"on": "message", "message_id": str(DEPARTURE), "after_s": 2},
    [{"action": "reply", "option_key": "second", "within_s": 30}],
    line=line(40, "Диспетчер, какой подъезд?"),
    reply_options=[{"key": "second", "label": "Второй подъезд"}],
    branches={
        "met": {"line": line(41, "Поняла, идём."), "effects": []},
        "late": {"line": line(42, "Поздно, мы уже внутри."), "effects": []},
        "missed": {"line": None, "effects": [{"delay": str(ARRIVAL), "by_s": 30}]},
    },
)
ENTRANCE_LINE = UUID(ENTRANCE_EVENT["line"]["id"])
STAGES = {DEPARTURE: "enroute", ARRIVAL: "onscene", WORKS: "onscene", COMPLETION: "done"}


def entrance_world(reply: float, presented: dict[UUID, float], now: float):
    state = journal(
        presented={DEPARTURE: 10, ENTRANCE_LINE: 13, **presented},
        calls=[call(0, answered=1)],
        firings={ENTRANCE: 12},
        replies={ENTRANCE_LINE: [(reply, "second")]},
    )
    return world({ENTRANCE: ENTRANCE_EVENT}, state, at(now), stages=STAGES)


def test_late_answer_of_later_stage_waits_for_its_report():
    """lift-stuck-103-1: «Поздно, мы уже внутри.» звучало до «На месте…» — теперь после."""
    arrival, _, answer = apply_world([report(ARRIVAL, 20)], entrance_world(60, {}, 61), set())
    assert answer.planned["message"]["text"] == "Поздно, мы уже внутри."
    # Доклад о прибытии — по исходу события, ответ ветки ждёт, пока он прозвучит.
    assert arrival.ready_at == at(60)
    assert answer.ready_at is None

    state = entrance_world(60, {ARRIVAL: 66}, 67)
    _, _, answer = apply_world([report(ARRIVAL, 20, issued=True)], state, set())
    assert answer.ready_at == at(66)


def test_answer_without_stage_words_is_not_held():
    _, _, answer = apply_world([report(ARRIVAL, 20)], entrance_world(20, {}, 21), set())
    assert answer.planned["message"]["text"] == "Поняла, идём."
    assert answer.ready_at == at(20)


# --- Ответ ветки не звучит после доклада, который событие держит (HQ-028) -------------------

TURNING = "Понял поправку, разворачиваемся."
TURNING_EVENT = {
    **READBACK_EVENT,
    "branches": {
        **READBACK_EVENT["branches"],
        "met": {"line": line(13, TURNING), "effects": []},
    },
}


@pytest.mark.parametrize(
    ("replies", "calls", "fixed"),
    [
        ([(16, "fix")], (), 16),  # поправили вариантом в том же разговоре
        ((), [call(30, answered=32)], 32),  # перезвонили расчёту в пути
    ],
)
def test_turning_back_sounds_before_arrival(replies, calls, fixed):
    """Живой звонок 17.10, pipe-basement-104-2: «Прибыли» → «Понял поправку,
    разворачиваемся». Доклад о прибытии ждёт исхода повтора адреса, ответ ветки готов в тот же
    момент и выдаётся первым (`worker.training.delivery_order`)."""
    arrival = report(ARRIVAL, 12)
    arrival = replace(arrival, planned={**arrival.planned, "justifies_state": "arrived"})
    state = world({READBACK: TURNING_EVENT}, readback_journal(replies, calls), at(fixed + 1))
    ready = [
        item
        for item in apply_world([arrival], state, set())
        if item.ready_at is not None and item.ready_at <= at(fixed + 1)
    ]
    spoken = [item.planned["message"]["text"] for item in sorted(ready, key=delivery_order)]
    assert spoken[-2:] == [TURNING, "доклад"]
    assert [item.ready_at for item in sorted(ready, key=delivery_order)][-2:] == [at(fixed)] * 2


def test_turning_back_never_follows_a_missed_readback():
    """Не поправили в срок — расчёт приехал не туда: «разворачиваемся» уже не звучит, даже
    если поправка пришла после прибытия."""
    state = world(
        {READBACK: TURNING_EVENT},
        replace(
            readback_journal([(60, "fix")]),
            presented={DEPARTURE: at(10), READBACK_LINE: at(11), ARRIVAL: at(52)},
        ),
        at(61),
    )
    texts = [
        item.planned["message"]["text"] for item in apply_world([report(ARRIVAL, 12)], state, set())
    ]
    assert TURNING not in texts


# --- Ветка ждёт звонка абоненту (HQ-019) -----------------------------------------------------

DOOR = UUID("00000000-0000-4000-8000-0000000000e7")
CALLER_EXT = "405"
CALLER_EXTS = {"caller": {CALLER_EXT}}
NO_CALL = line(20, "Хозяйка не открыла. Вскрываем шахту с чердака, это надолго.")
DOOR_EVENT = event(
    DOOR,
    "clarify",
    {"on": "message", "message_id": str(ARRIVAL), "after_s": 2},
    [{"action": "reply", "option_key": "owner", "within_s": 30}],
    line=line(19, "Диспетчер, хозяева дома будут? Квартира закрыта."),
    reply_options=[
        {"key": "owner", "label": "Позвоню хозяйке, она откроет"},
        {"key": "wait", "label": "Ждите, хозяйка выйдет сама"},
    ],
    branches={
        "met": {
            "line": line(21, "Принял, так и сделаем."),
            "effects": [],
            "awaits_call": {
                "contact_role": "caller",
                "within_s": 40,
                "otherwise": [
                    {"replace": str(WORKS), "with": NO_CALL},
                    {"delay": str(WORKS), "by_s": 40},
                ],
            },
        },
        "missed": {"line": None, "effects": [{"delay": str(WORKS), "by_s": 40}]},
    },
)
DOOR_BY_ID = {DOOR: DOOR_EVENT}


def door_journal(*, answer_at: float | None = 40.0, calls: list[dict] = ()) -> Journal:
    """Бригада спросила про хозяев (реплика услышана в 33 с); `answer_at` — ответ «позвоню»."""
    replies = (
        {UUID(DOOR_EVENT["line"]["id"]): [(answer_at, "owner")]} if answer_at is not None else None
    )
    return journal(
        presented={ARRIVAL: 30, UUID(DOOR_EVENT["line"]["id"]): 33},
        calls=[*DISPATCHED, *calls],
        firings={DOOR: 32},
        replies=replies,
    )


def test_right_answer_holds_report_until_caller_is_called():
    """«Позвоню хозяйке» одно доклад не освобождает: мир ждёт звонка до срока."""
    state = world(DOOR_BY_ID, door_journal(), at(50), contact_exts=CALLER_EXTS)
    # Ответ в 40 с + 40 с ожидания звонка.
    assert state.holds[WORKS] == at(80)
    [works, _, _] = apply_world([report(WORKS, 38)], state, set())
    assert works.ready_at == at(80)
    assert works.planned["message"]["text"] == "доклад"


def test_call_to_caller_releases_report():
    """Позвонил заявителю — работы идут, доклад приходит по ветке `met`."""
    called = [call(45, ext=CALLER_EXT, brigade=None, answered=46, ended=70)]
    state = world(DOOR_BY_ID, door_journal(calls=called), at(50), contact_exts=CALLER_EXTS)
    assert state.holds[WORKS] == at(40)
    [works, _, answer] = apply_world([report(WORKS, 38)], state, set())
    assert works.ready_at == at(40)
    assert works.planned["message"]["text"] == "доклад"
    assert answer.planned["message"]["text"] == "Принял, так и сделаем."


def test_no_call_by_deadline_changes_the_report():
    """Не позвонил к сроку — бригада вскрывает шахту с чердака, работы затягиваются."""
    state = world(DOOR_BY_ID, door_journal(), at(81), contact_exts=CALLER_EXTS)
    [works, _, _] = apply_world([report(WORKS, 38)], state, set())
    assert works.planned["message"]["text"] == NO_CALL["text"]
    # Диспетчер уже прождал срок ожидания (40 → 80 с), поэтому дальше доклад не отодвигается:
    # задержка ветки ограничена MAX_REPORT_WAIT от начала ожидания (GP-12), как в ветке wrong.
    assert works.ready_at == at(40)


def test_late_call_still_releases_report():
    """Позвонил после срока — доклад больше не держим (мир уже пошёл по `otherwise`)."""
    called = [call(85, ext=CALLER_EXT, brigade=None, answered=86)]
    state = world(DOOR_BY_ID, door_journal(calls=called), at(90), contact_exts=CALLER_EXTS)
    [works, _, _] = apply_world([report(WORKS, 38)], state, set())
    assert works.ready_at == at(40)
    assert works.planned["message"]["text"] == "доклад"


def test_without_caller_in_phone_branch_works_as_before():
    """Заявителя нет в телефоне занятия — звонить некуда, ветка действует без ожидания."""
    state = world(DOOR_BY_ID, door_journal(), at(81), contact_exts={})
    [works, _, _] = apply_world([report(WORKS, 38)], state, set())
    assert works.ready_at == at(40)
    assert works.planned["message"]["text"] == "доклад"


def test_call_before_the_question_does_not_count():
    """Звонок до вопроса бригады ответом не считается: хозяйку ещё не о чем просить."""
    early = [call(10, ext=CALLER_EXT, brigade=None, answered=11, ended=20)]
    state = world(DOOR_BY_ID, door_journal(calls=early), at(50), contact_exts=CALLER_EXTS)
    assert state.holds[WORKS] == at(80)


def test_missed_answer_ignores_the_wait():
    """Не ответил бригаде вовсе — ветка `missed`, ожидания звонка в ней нет."""
    state = world(DOOR_BY_ID, door_journal(answer_at=None), at(81), contact_exts=CALLER_EXTS)
    [works, _] = apply_world([report(WORKS, 38)], state, set())
    assert works.ready_at == at(63)
    assert works.planned["message"]["text"] == "доклад"
