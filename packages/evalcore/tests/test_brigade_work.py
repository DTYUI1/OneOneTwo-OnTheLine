"""DT-10: исход событий бригады для мира и критерий «Работа с бригадой» для разбора."""

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from evalcore.brigade import (
    BrigadeWorkCriterion,
    effects_of,
    resolve_event,
    targets_of,
)
from evalcore.defaults import (
    BRIGADE_LATE_SCORE,
    BRIGADE_UNTOLD_SCORE,
    BRIGADE_WEIGHTS,
    COMMENT_WEIGHTS,
    CRITERIA,
)
from evalcore.models import EvalContext
from evalcore.scoring import evaluate

GOLDEN = Path(__file__).parents[3] / "data" / "golden_scenarios" / "case-01.json"
T0 = datetime(2026, 10, 8, 9, 0, tzinfo=UTC)
CREW = "00000000-0000-4000-8000-000000000001"
WORKS = "00000000-0000-4000-8000-0000000000a3"
ARRIVAL = "00000000-0000-4000-8000-0000000000a2"


def at(seconds: float) -> datetime:
    return T0 + timedelta(seconds=seconds)


def iso(seconds: float) -> str:
    return at(seconds).isoformat()


def line(text: str) -> dict:
    return {"id": "00000000-0000-4000-8000-0000000000f1", "version": 1, "text": text, "audio": None}


def clarify() -> dict:
    return {
        "kind": "clarify",
        "brigade_id": CREW,
        "trigger": {"on": "message", "message_id": "m-arrival", "after_s": 2},
        "line": line("На каком этаже квартира сто пятнадцать?"),
        "expect": [{"action": "reply", "option_key": "floor_9", "within_s": 40}],
        "reply_options": [
            {"key": "floor_9", "label": "Девятый этаж"},
            {"key": "unknown", "label": "Не знаю — ищите по подъездам"},
        ],
        "branches": {
            "met": {"line": None, "effects": []},
            "wrong": {"line": None, "effects": [{"delay": WORKS, "by_s": 60}]},
            "missed": {"line": None, "effects": [{"delay": WORKS, "by_s": 60}]},
        },
        "review": {"label": "Расчёт спросил этаж", "critical": False},
    }


def request_service() -> dict:
    return {
        "kind": "request_service",
        "brigade_id": CREW,
        "trigger": {"on": "message", "message_id": "m-works", "after_s": 3},
        "line": line("Мужчина без сознания. Срочно нужна скорая!"),
        "expect": [{"action": "call_service", "phone_exts": ["103", "112"], "within_s": 60}],
        "branches": {},
        "review": {"label": "Расчёт попросил скорую", "critical": False},
    }


def silence() -> dict:
    return {
        "kind": "silence",
        "brigade_id": CREW,
        "trigger": {"on": "no_contact", "state": "working", "silent_s": 40},
        "line": None,
        "expect": [{"action": "call_brigade", "within_s": 60}],
        "branches": {"missed": {"line": None, "effects": [{"delay": WORKS, "by_s": 45}]}},
        "review": {"label": "Расчёт долго молчал", "critical": False},
    }


def alarm() -> dict:
    return {
        "kind": "alarm",
        "brigade_id": CREW,
        "priority": "alarm",
        "trigger": {"on": "state", "state": "working", "after_s": 20},
        "line": line("Тревога! Боец упал в пролёт лестницы."),
        "expect": [
            {"action": "answer_call", "within_s": 15, "weight": 0.1},
            {
                "action": "call_service",
                "phone_exts": ["103", "112"],
                "within_s": 60,
                "weight": 0.9,
                "critical": True,
            },
        ],
        "branches": {},
        "review": {"label": "Тревога: травмирован боец", "critical": False},
    }


def readback() -> dict:
    wrong_place = {
        "line": None,
        "effects": [
            {"replace": ARRIVAL, "with": line("Мы на Бескудниковском переулке, проверьте адрес!")},
            {"delay": ARRIVAL, "by_s": 45},
        ],
    }
    return {
        "kind": "readback_error",
        "brigade_id": CREW,
        "trigger": {"on": "message", "message_id": "m-departure", "after_s": 1},
        "line": line("Как поняли? Бескудниковский переулок, двадцать четыре, выезжаем!"),
        "expect": [{"action": "correct_readback", "option_key": "fix", "within_s": 40}],
        "reply_options": [
            {"key": "fix", "label": "Поправка по адресу: Бескудниковский бульвар, 24"},
            {"key": "ok", "label": "Понял"},
        ],
        "branches": {
            "met": {"line": line("Понял, Бескудниковский бульвар, едем."), "effects": []},
            "wrong": wrong_place,
            "missed": wrong_place,
        },
        "review": {"label": "Расчёт повторил адрес с ошибкой", "critical": True},
    }


def call(ext: str, started: float, *, brigade: str | None = None, answered: float | None = None):
    return {
        "id": f"call-{ext}-{started}",
        "service_id": ext,
        "phone_ext": ext,
        "brigade_id": brigade,
        "direction": "outbound",
        "refusal": None,
        "started_at": iso(started),
        "answered_at": iso(answered) if answered is not None else None,
        "ended_at": None,
        "transcript": None,
    }


def reply(seconds: float, key: str) -> dict:
    return {"at": iso(seconds), "option_key": key}


# --- Мир: ветка события по ходу занятия -------------------------------------------------


@pytest.mark.parametrize(
    ("replies", "now", "branch", "state"),
    [
        ([reply(12, "floor_9")], 20, "met", "met"),
        ([reply(12, "unknown")], 20, "wrong", "wrong"),
        ([reply(55, "floor_9")], 60, "late", "late"),
        ([], 60, "missed", "missed"),
        ([], 20, None, "pending"),
    ],
)
def test_clarify_branches(replies, now, branch, state):
    outcome = resolve_event(clarify(), at(0), at(3), replies, [], at(now))
    assert outcome.branch == branch
    assert outcome.expectations[0].state == state


def test_missed_turns_late_when_dispatcher_acts_after_deadline():
    event = request_service()
    calls = [call("103", 90)]
    assert resolve_event(event, at(0), at(2), [], calls, at(70)).branch == "missed"
    later = resolve_event(event, at(0), at(2), [], calls, at(95))
    assert later.branch == "late"
    assert later.at == at(90)


@pytest.mark.parametrize("ext", ["103", "112"])
def test_request_service_counts_103_and_112(ext):
    outcome = resolve_event(request_service(), at(0), at(2), [], [call(ext, 30)], at(40))
    assert outcome.branch == "met"
    assert outcome.expectations[0].reaction_s == 30


def test_spoken_request_does_not_eat_service_deadline():
    """Проверка 17.10: перезвон, «старший на связи» и сама просьба не съедают срок звонка."""
    calls = [call("103", 70)]
    assert resolve_event(request_service(), at(0), at(2), [], calls, at(80)).branch == "late"
    outcome = resolve_event(request_service(), at(0), at(2), [], calls, at(80), spoken_s=15)
    assert outcome.branch == "met"
    assert outcome.expectations[0].reaction_s == 70
    missed = resolve_event(request_service(), at(0), at(2), [], [], at(76), spoken_s=15)
    assert missed.branch == "missed"


def test_refused_call_or_other_service_does_not_count():
    refused = {**call("103", 20), "refusal": "busy"}
    calls = [{**call("103", -5), "refusal": "busy"}, refused, call("102", 10)]
    outcome = resolve_event(request_service(), at(0), at(2), [], calls, at(61))
    assert outcome.branch == "missed"
    assert outcome.ahead is None


def test_call_before_card_accepted_is_not_ahead():
    """Звонок в службу до «Принята» — не «вызвана заранее» (GP-28)."""
    outcome = resolve_event(
        request_service(), at(0), at(2), [], [call("103", -30)], at(61), (), at(-20)
    )
    assert outcome.branch == "missed"


def test_silence_met_by_answered_call_to_crew():
    calls = [call("201", 30, brigade=CREW, answered=33)]
    outcome = resolve_event(silence(), at(0), None, [], calls, at(40))
    assert outcome.branch == "met"
    assert outcome.expectations[0].reaction_s == 33


def test_silence_missed_and_unanswered_call_is_not_contact():
    calls = [call("201", 30, brigade=CREW)]
    outcome = resolve_event(silence(), at(0), None, [], calls, at(61))
    assert outcome.branch == "missed"
    assert outcome.expectations[0].state == "missed"
    assert effects_of(silence(), outcome.branch) == [{"delay": WORKS, "by_s": 45}]


def test_alarm_waits_for_ambulance_after_answer():
    event = alarm()
    answered = resolve_event(event, at(0), at(4), [], [], at(20))
    assert answered.branch is None
    assert [item.state for item in answered.expectations] == ["met", "pending"]
    done = resolve_event(event, at(0), at(4), [], [call("103", 35)], at(40))
    assert done.branch == "met"
    assert done.at == at(35)


def test_alarm_unanswered_is_missed_not_unheard():
    outcome = resolve_event(alarm(), at(0), None, [], [], None)
    assert outcome.branch == "missed"
    assert [item.state for item in outcome.expectations] == ["missed", "unheard"]


def test_unheard_request_does_not_require_anything_but_world_moves_on():
    outcome = resolve_event(request_service(), at(0), None, [], [], at(61))
    assert outcome.branch == "missed"
    assert outcome.expectations[0].state == "unheard"


@pytest.mark.parametrize(
    ("replies", "calls", "now", "branch", "detail"),
    [
        ([reply(5, "fix")], [], 6, "met", "fix"),
        ([], [call("201", 18, brigade=CREW, answered=20)], 21, "met", "call"),
        # «Понял», потом звонок в пути — поправили.
        ([reply(5, "ok")], [call("201", 25, brigade=CREW, answered=27)], 41, "met", "call"),
        ([reply(5, "ok")], [], 41, "wrong", "ok"),
        ([], [], 41, "missed", None),
        # Поправка после срока не считается: расчёт уже приехал не туда.
        ([reply(45, "fix")], [call("201", 50, brigade=CREW, answered=52)], 60, "missed", None),
    ],
)
def test_readback_branches(replies, calls, now, branch, detail):
    outcome = resolve_event(readback(), at(0), at(1), replies, calls, at(now))
    assert outcome.branch == branch
    assert outcome.expectations[0].detail == detail


def test_readback_understood_is_not_wrong_until_deadline():
    # Расчёт ещё в пути: после «Понял» диспетчер может перезвонить.
    pending = resolve_event(readback(), at(0), at(1), [reply(5, "ok")], [], at(30))
    assert pending.branch is None
    assert pending.expectations[0].state == "pending"
    wrong = resolve_event(readback(), at(0), at(1), [reply(5, "ok")], [], None)
    assert wrong.branch == "wrong"
    # Срок поправки — от того, как повтор услышали (1 с), а не от срабатывания.
    assert wrong.at == at(41)


@pytest.mark.parametrize(
    ("text", "seconds", "branch", "detail"),
    [
        # Верный адрес фразой, без «поправка по адресу» (HQ-024) — поправка.
        ("Нет, Бескудниковский бульвар, двадцать четыре", 10, "met", "said"),
        ("Бескудниковский бульвар 24", 10, "met", "said"),
        # Повтор ошибки бригады, другой дом, обычная фраза — не поправка.
        ("Бескудниковский переулок, 24", 10, "wrong", "ok"),
        ("Бескудниковский бульвар, 25", 10, "wrong", "ok"),
        ("Выезжайте", 10, "wrong", "ok"),
        # До срабатывания и после срока не считается.
        ("Бескудниковский бульвар 24", -5, "wrong", "ok"),
        ("Бескудниковский бульвар 24", 45, "wrong", "ok"),
    ],
)
def test_readback_fixed_by_phrase_after_understood(text, seconds, branch, detail):
    said = [{"at": iso(seconds), "text": text}]
    outcome = resolve_event(readback(), at(0), at(1), [reply(5, "ok")], [], None, said)
    assert outcome.branch == branch
    assert outcome.expectations[0].detail == detail


def test_readback_briefing_is_not_a_fix():
    """Повторная вводная после срабатывания — не поправка повтора адреса (HQ-024)."""
    said = [{"at": iso(10), "text": "Бескудниковский бульвар 24, дым", "via": "briefing"}]
    outcome = resolve_event(readback(), at(0), at(1), [reply(5, "ok")], [], None, said)
    assert outcome.branch == "wrong"


def test_readback_fixed_by_phrase_is_marked():
    """Поправку фразой видно по исходу: на неё отвечает ветка, а не окно телефона (HQ-024)."""
    said = [{"at": iso(10), "text": "Бескудниковский бульвар 24, доложите по прибытии"}]
    outcome = resolve_event(readback(), at(0), at(1), [reply(5, "ok")], [], None, said)
    assert outcome.fixed_by_phrase
    by_option = resolve_event(readback(), at(0), at(1), [reply(5, "fix")], [], None)
    assert by_option.branch == "met" and not by_option.fixed_by_phrase


def test_readback_dispatch_call_before_event_does_not_count():
    calls = [call("201", -10, brigade=CREW, answered=-8)]
    outcome = resolve_event(readback(), at(0), at(1), [], calls, None)
    assert outcome.branch == "missed"


def test_readback_unheard_moves_world_but_is_not_scored():
    outcome = resolve_event(readback(), at(0), None, [], [], None)
    assert outcome.branch == "missed"
    assert outcome.expectations[0].state == "unheard"


def test_readback_wrong_place_replaces_and_delays_arrival():
    event = readback()
    assert targets_of(event) == {ARRIVAL}
    assert effects_of(event, "met") == []
    for branch in ("wrong", "missed"):
        assert [next(iter(effect)) for effect in effects_of(event, branch)] == [
            "replace",
            "delay",
        ]


def test_targets_of_lists_delayed_and_replaced_reports():
    assert targets_of(clarify()) == {WORKS}
    assert targets_of(request_service()) == set()


# --- Разбор: критерий brigade_work ---------------------------------------------------------


def context(fired: list[dict], calls: list[dict] | None = None, weight: float = 1.0):
    weights = {key: 1.0 for key in CRITERIA} | {"brigade_work": weight}
    return EvalContext(
        {"reference": {"expected_flow": []}},
        {},
        [],
        calls or [],
        {"weights": weights, "critical_cap": 0.5},
        scenario_events=tuple(fired),
    )


def fired(event, seconds=0, presented=2, replies=(), source="plan", said=()):
    return {
        "event": event,
        "fired_at": iso(seconds),
        "source": source,
        "presented_at": iso(seconds + presented) if presented is not None else None,
        "replies": list(replies),
        "said": list(said),
    }


def told(seconds: float, text: str = "Скорая уже едет, ждите.") -> dict:
    """Диспетчер сказал бригаде, что служба едет (HQ-055)."""
    return {"at": iso(seconds), "text": text}


def test_all_four_kinds_met_score_one():
    events = [
        fired(clarify(), 0, replies=[reply(10, "floor_9")]),
        fired(request_service(), 100, said=[told(140)]),
        fired(silence(), 300, presented=None),
        fired(alarm(), 500, presented=3, said=[told(548)]),
    ]
    calls = [
        call("103", 130),
        call("201", 320, brigade=CREW, answered=322),
        call("112", 540),
    ]
    result = BrigadeWorkCriterion().evaluate(context(events, calls))
    assert result.score == 1.0
    assert result.weight == 1.0
    assert not result.critical
    assert result.evidence[0] == (
        "Расчёт спросил этаж: ответили вариантом «Девятый этаж» через 0:10."
    )
    assert result.evidence[1] == (
        "Расчёт попросил скорую: позвонили в 103 через 0:30; сообщили бригаде, что служба "
        "едет, через 0:10 после звонка."
    )
    assert result.evidence[2] == "Расчёт долго молчал: позвонили бригаде через 0:22."
    assert result.evidence[3] == (
        "Тревога: травмирован боец: ответили на вызов через 0:03; позвонили в 112 через 0:40; "
        "сообщили бригаде, что служба едет, через 0:08 после звонка."
    )


@pytest.mark.parametrize(
    ("replies", "score", "text"),
    [
        (
            [reply(50, "floor_9")],
            BRIGADE_LATE_SCORE,
            "ответили вариантом «Девятый этаж» через 0:50, позже срока 0:40",
        ),
        (
            [reply(10, "unknown")],
            0.0,
            "ответили вариантом «Не знаю — ищите по подъездам» через 0:10 — неверно",
        ),
        ([], 0.0, "бригаде не ответили"),
    ],
)
def test_clarify_late_wrong_missed(replies, score, text):
    result = BrigadeWorkCriterion().evaluate(context([fired(clarify(), replies=replies)]))
    assert result.score == score
    assert result.evidence == [f"Расчёт спросил этаж: {text}."]


def test_request_late_and_missed():
    late = BrigadeWorkCriterion().evaluate(
        context([fired(request_service(), said=[told(80)])], [call("103", 75)])
    )
    assert late.score == BRIGADE_LATE_SCORE
    missed = BrigadeWorkCriterion().evaluate(context([fired(request_service())]))
    assert missed.score == 0.0
    assert missed.evidence == ["Расчёт попросил скорую: в 103 или 112 не позвонили."]


def test_silence_late_and_missed():
    late = BrigadeWorkCriterion().evaluate(
        context([fired(silence(), presented=None)], [call("201", 70, brigade=CREW, answered=72)])
    )
    assert late.score == BRIGADE_LATE_SCORE
    missed = BrigadeWorkCriterion().evaluate(context([fired(silence(), presented=None)]))
    assert missed.score == 0.0
    assert missed.evidence == ["Расчёт долго молчал: бригаде не позвонили."]


def test_alarm_without_reaction_is_critical():
    result = BrigadeWorkCriterion().evaluate(context([fired(alarm(), presented=None)]))
    assert result.critical
    assert result.score == 0.0
    assert "Критическая ошибка: по тревоге бригады к бойцу не вызвали скорую." in result.explanation


def test_alarm_answered_but_no_ambulance_is_critical():
    # Решение 15.10: на бойца нужна своя скорая; ответ на вызов без неё — 0,1 события.
    result = BrigadeWorkCriterion().evaluate(context([fired(alarm(), presented=5)]))
    assert result.critical
    assert result.score == pytest.approx(0.1)


def test_alarm_ambulance_called_before_alarm_does_not_count():
    # Скорую вызывали к жильцу до тревоги — к бойцу нужна ещё одна.
    result = BrigadeWorkCriterion().evaluate(
        context([fired(alarm(), 100, presented=3)], [call("103", 30)])
    )
    assert result.critical
    assert result.evidence[0].endswith("в 103 или 112 не позвонили.")


@pytest.mark.parametrize(
    ("presented", "ambulance", "score", "text"),
    [
        (3, 40, 1.0, "ответили на вызов через 0:03; позвонили в 103 через 0:40"),
        (
            3,
            90,
            0.1 + 0.9 * BRIGADE_LATE_SCORE,
            "ответили на вызов через 0:03; позвонили в 103 через 1:30, позже срока 1:00",
        ),
        (
            # Тревогу не взяли, услышали в своём звонке бригаде и вызвали скорую в срок.
            30,
            50,
            0.1 * BRIGADE_LATE_SCORE + 0.9,
            "реплику услышали через 0:30, позже срока 0:15; позвонили в 103 через 0:50",
        ),
    ],
)
def test_alarm_ambulance_called_is_not_critical(presented, ambulance, score, text):
    said = [told(ambulance + 15)]
    result = BrigadeWorkCriterion().evaluate(
        context([fired(alarm(), presented=presented, said=said)], [call("103", ambulance)])
    )
    assert not result.critical
    assert result.score == pytest.approx(score)
    assert result.evidence == [
        f"Тревога: травмирован боец: {text}; сообщили бригаде, что служба едет, через 0:15 "
        "после звонка."
    ]


@pytest.mark.parametrize(
    ("replies", "calls", "text"),
    [
        ([reply(5, "fix")], [], "поправили вариантом через 0:05"),
        (
            [],
            [call("201", 18, brigade=CREW, answered=20)],
            "позвонили расчёту и поправили через 0:20",
        ),
    ],
)
def test_readback_corrected(replies, calls, text):
    result = BrigadeWorkCriterion().evaluate(
        context([fired(readback(), presented=1, replies=replies)], calls)
    )
    assert result.score == 1.0
    assert not result.critical
    assert result.evidence == [f"Расчёт повторил адрес с ошибкой: {text}."]


@pytest.mark.parametrize(
    ("replies", "text"),
    [
        ([], "не поправили — расчёт приехал не туда"),
        ([reply(5, "ok")], "ответили вариантом «Понял», не поправили — расчёт приехал не туда"),
    ],
)
def test_readback_not_corrected_is_critical(replies, text):
    result = BrigadeWorkCriterion().evaluate(
        context([fired(readback(), presented=1, replies=replies)])
    )
    assert result.score == 0.0
    assert result.critical
    assert result.evidence == [f"Расчёт повторил адрес с ошибкой: {text}."]
    assert "Критическая ошибка: расчёт повторил адрес с ошибкой" in result.explanation


def test_readback_unheard_is_not_critical():
    result = BrigadeWorkCriterion().evaluate(context([fired(readback(), presented=None)]))
    assert not result.critical
    assert result.weight == 0.0


def test_unheard_event_is_listed_but_not_scored():
    events = [fired(request_service(), presented=None), fired(clarify(), 100, replies=[])]
    result = BrigadeWorkCriterion().evaluate(context(events))
    assert result.evidence[0] == (
        "Расчёт попросил скорую: реплику не услышали — на вызов бригады не ответили."
    )
    assert result.score == 0.0  # оценено только уточнение


def test_fallback_event_is_shown_but_not_scored():
    nudge = {**request_service(), "trigger": {"on": "event", "event_id": "x", "branch": "missed"}}
    nudge["review"] = {"label": "Расчёт снова спросил про скорую", "critical": False}
    events = [fired(request_service(), said=[told(80)]), fired(nudge, 61)]
    result = BrigadeWorkCriterion().evaluate(context(events, [call("103", 70)]))
    assert result.score == BRIGADE_LATE_SCORE
    assert result.evidence[1].startswith("Страховка мира. Расчёт снова спросил про скорую")


def test_inject_is_labelled_in_review():
    result = BrigadeWorkCriterion().evaluate(
        context([fired(alarm(), presented=3, source="inject")], [call("103", 20)])
    )
    # Время подачи — по Москве, как на доске преподавателя: 09:00 UTC — 12:00 МСК.
    assert result.evidence[0].startswith("Вводная преподавателя, 12:00:00. Тревога")


def test_no_events_means_criterion_not_applied():
    result = BrigadeWorkCriterion().evaluate(context([]))
    assert result.weight == 0.0
    assert "не применялся" in result.explanation


def golden(fired_list: list[dict], **weights: float) -> EvalContext:
    fixture = json.loads(GOLDEN.read_text(encoding="utf-8"))
    settings = dict(fixture["settings"])
    settings["weights"] = {**settings["weights"], **weights}
    return EvalContext(
        scenario=fixture["scenario"],
        current=fixture["current"],
        events=fixture["events"],
        calls=fixture["calls"],
        settings=settings,
        scenario_events=tuple(fired_list),
    )


def test_scoring_uses_configured_weight_and_ignores_unapplied():
    old = evaluate(golden([]))
    unapplied = evaluate(golden([], brigade_work=2.0))
    assert unapplied.total == old.total
    assert [item.key for item in unapplied.criteria] == list(CRITERIA)

    failed = evaluate(golden([fired(alarm(), presented=None)], brigade_work=2.0))
    assert [item.key for item in failed.criteria][-1] == "brigade_work"
    assert failed.criteria[-1].weight == 2.0
    assert failed.critical_flags[-1] == "brigade_work"
    assert failed.total <= 0.5


def test_old_settings_without_weight_skip_criterion():
    result = evaluate(golden([fired(alarm(), presented=None)]))
    assert "brigade_work" not in [item.key for item in result.criteria]


def test_default_weight_is_declared_next_to_others():
    assert BRIGADE_WEIGHTS == {"brigade_work": 1.0}
    assert "brigade_work" not in COMMENT_WEIGHTS


# --- DT-16: ответ голосом в разборе ------------------------------------------------------


def voice(seconds: float, key: str, loudness: str | None = "ok", failures: int = 0) -> dict:
    return {
        **reply(seconds, key),
        "mode": "voice",
        "text": "Девятый этаж",
        "loudness": loudness,
        "voice_failures": failures,
    }


@pytest.mark.parametrize(
    ("answer", "text"),
    [
        (voice(10, "floor_9"), "ответили голосом «Девятый этаж» через 0:10 (громкость в норме)"),
        (
            voice(10, "floor_9", "quiet", 1),
            "ответили голосом «Девятый этаж» через 0:10 (слишком тихо, голос не сопоставлен: 1)",
        ),
        (voice(10, "floor_9", None), "ответили голосом «Девятый этаж» через 0:10"),
        (
            {**reply(10, "floor_9"), "mode": "option", "voice_failures": 2},
            "ответили вариантом «Девятый этаж» через 0:10 (голос не сопоставлен: 2)",
        ),
    ],
)
def test_voice_reply_is_named_in_evidence_and_scored_as_option(answer, text):
    result = BrigadeWorkCriterion().evaluate(context([fired(clarify(), replies=[answer])]))
    assert result.score == 1.0
    assert result.evidence == [f"Расчёт спросил этаж: {text}."]


def test_voice_readback_correction_counts_like_option():
    result = BrigadeWorkCriterion().evaluate(
        context([fired(readback(), presented=1, replies=[voice(5, "fix")])])
    )
    assert result.score == 1.0
    assert not result.critical
    assert result.evidence == [
        "Расчёт повторил адрес с ошибкой: поправили голосом через 0:05 (громкость в норме)."
    ]


# --- HQ-055: о вызванной по просьбе службе бригаде сообщает диспетчер ----------------------


def ended_call(ext: str, started: float, ended: float) -> dict:
    return call(ext, started) | {"ended_at": iso(ended)}


@pytest.mark.parametrize(
    ("said", "now", "news", "news_at"),
    [
        # Перезвонил после звонка в службу: «уже едет» — сказал до приезда (отбой + 20 с).
        ([told(140)], 141, "told", 140),
        # «Отправил» без названия службы после просьбы — тоже весть (как ответ «уже вызвал»).
        ([told(145, "Отправил, ждите.")], 146, "told", 145),
        # «Сейчас вызову» — не весть; срок ещё не вышел — исхода нет.
        ([told(105, "Хорошо, сейчас вызову, ждите.")], 150, None, None),
        # Не сказал к приезду службы — служба приезжает «внезапно».
        ([], 160, "untold", 158),
        # Сказал после приезда — поздно: служба уже на месте.
        ([told(170)], 171, "untold", 158),
        # «Уже вызвал» до набора номера службы — неправда, не весть; потом промолчал.
        ([told(110, "Скорую уже вызвал, едет.")], 160, "untold", 158),
        # До набора — не в счёт, после отбоя сказал снова — весть с этого момента.
        ([told(110), told(150)], 151, "told", 150),
        # Сказал, пока звонок в службу шёл (с удержания линии службы), — уже после набора.
        ([told(125)], 160, "told", 125),
    ],
)
def test_news_about_called_service(said, now, news, news_at):
    outcome = resolve_event(
        request_service(),
        at(100),
        at(102),
        [],
        [ended_call("103", 125, 138)],
        at(now),
        said,
    )
    assert outcome.branch == "met"
    assert outcome.news == news
    assert outcome.news_at == (at(news_at) if news_at is not None else None)
    assert outcome.news_by == at(158)


def test_news_waits_for_service_call_to_end():
    """Пока звонок в службу идёт, сообщить бригаде нельзя — срок ещё не известен."""
    outcome = resolve_event(
        request_service(), at(100), at(102), [], [call("103", 125)], at(200), []
    )
    assert outcome.branch == "met"
    assert outcome.news is None and outcome.news_by is None


def test_news_not_applied_without_call():
    outcome = resolve_event(request_service(), at(100), at(102), [], [], None, [told(110)])
    assert outcome.branch == "missed"
    assert outcome.news is None


def test_untold_news_scored_like_untold_ahead():
    """Не сообщили о службе, вызванной по просьбе, — тот же балл, что за непредупреждённую
    бригаду при вызове заранее (GP-28, BRIGADE_UNTOLD_SCORE)."""
    result = BrigadeWorkCriterion().evaluate(
        context([fired(request_service(), 100)], [ended_call("103", 130, 140)])
    )
    assert result.score == pytest.approx(BRIGADE_UNTOLD_SCORE)
    assert result.evidence == [
        "Расчёт попросил скорую: позвонили в 103 через 0:30; бригаде не сообщили, что служба "
        "едет, — служба приехала для неё неожиданно."
    ]
    assert "не сообщили, что она едет, — 1; балл события не выше" in result.explanation


def test_untold_news_after_late_call_lowers_late_score():
    result = BrigadeWorkCriterion().evaluate(
        context([fired(request_service(), 100)], [ended_call("103", 200, 210)])
    )
    # Меньшее из двух, а не произведение (лист решений 18.10): 0,5, не 0,45.
    assert result.score == pytest.approx(min(BRIGADE_LATE_SCORE, BRIGADE_UNTOLD_SCORE))
    assert result.score == pytest.approx(0.5)


def test_told_news_keeps_full_score():
    result = BrigadeWorkCriterion().evaluate(
        context(
            [fired(request_service(), 100, said=[told(145, "Отправил, ждите.")])],
            [ended_call("103", 130, 140)],
        )
    )
    assert result.score == 1.0
    assert "сообщили бригаде, что служба едет, через 0:15 после звонка" in result.evidence[0]
