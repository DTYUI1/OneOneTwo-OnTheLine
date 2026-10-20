"""GP-28: просьба бригады о службе, которую диспетчер вызвал заранее.

Без БД — мир (`scenario_events.world`, `due_events`): вызвал и сказал — бригада не просит;
вызвал и не сказал — просит, на «уже вызвал» отвечает «понял, ждём», без ответа служба
приезжает сама; не вызвал — как раньше. Загрузчик достраивает ветки и варианты ответа
(`service_defaults`). С БД — тот же путь через API на сценарии «Запах газа в подъезде» (104).
"""

import time
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

import pytest
from app.api.training.scenario_events import Journal, apply_world, due_events, world
from app.api.training.turns import Turn
from app.seed.service_defaults import REPLY_OPTIONS, with_service_defaults
from app.worker.training import delivery_order

from .test_c04_completion import seed_training
from .test_final_scenarios import Shift, explanation, open_shift, scenario_file
from .test_live_brigade import (
    ALARM,
    ALARM_EVENT,
    COMPLETION,
    CREW,
    DISPATCHED,
    NUDGE,
    NUDGE_EVENT,
    REQUEST,
    REQUEST_EVENT,
    WORKS,
    at,
    call,
    journal,
    line,
    report,
)
from .test_practice_gating import worker_tick


@pytest.mark.parametrize("told", [False, True])
def test_request_without_effects_holds_next_report_until_service_arrives(told):
    """Просьба без delay/replace тоже держит продолжение; повтор и «Принял» его не теряют."""
    request_line = UUID(REQUEST_EVENT["line"]["id"])
    calls = [*DISPATCHED, call(60, ext="103", brigade=None, answered=62)]
    snapshot = journal(
        presented={WORKS: 50, request_line: 55},
        firings={REQUEST: 53},
        calls=calls,
    )
    if told:
        snapshot = replace(
            snapshot, said={CREW: [{"at": at(75).isoformat(), "text": "Отправил, ждите"}]}
        )
    following = {WORKS: COMPLETION}
    events = {REQUEST: REQUEST_EVENT}
    # Длинный звонок в службу: 20 с от набора недостаточно, даже если бригаде уже сказали.
    for now in (81, 110):
        pending = world(events, snapshot, at(now), following=following)
        [completion, *_] = apply_world([report(COMPLETION, 80)], pending, set())
        assert completion.ready_at is not None and completion.ready_at > at(now)

    snapshot = replace(
        snapshot, calls=[*DISPATCHED, call(60, ext="103", brigade=None, answered=62, ended=120)]
    )
    # Прослушали повтор и подтвердили: очередь реплик отпущена, приезд ещё ждём.
    snapshot = replace(snapshot, turns=[Turn(CREW, at(125), at(128))])
    for now in (130, 141, 300):
        pending = world(events, snapshot, at(now), following=following)
        [completion, *_] = apply_world([report(COMPLETION, 80)], pending, set())
        assert completion.ready_at == at(140)
        assert (completion.ready_at <= at(now)) is (now >= 140)


def test_alarm_replacement_waits_for_called_service():
    """Тревога со звонком в службу: подмена доклада ветки met («напарника забрала скорая»)
    ждёт приезда скорой — 20 с после отбоя звонка в неё, как у просьбы (HQ-055); пока
    службу не вызвали, доклад не держится."""
    taken = line(22, "Шланг заменили, газ подали. Напарника забрала скорая.")
    alarm = {
        **ALARM_EVENT,
        "branches": {
            name: {"line": None, "effects": [{"replace": str(COMPLETION), "with": taken}]}
            for name in ("met", "late")
        },
    }
    alarm_line = UUID(ALARM_EVENT["line"]["id"])
    calls = [
        *DISPATCHED,
        call(100, answered=101, ended=108, direction="inbound"),
        call(110, ext="103", brigade=None, answered=112, ended=125),
    ]
    # Пока скорую не вызвали, тревога итог не держит: он звучит прежним.
    pending = journal(presented={alarm_line: 101}, firings={ALARM: 100}, calls=calls[:2])
    shaped = world({ALARM: alarm}, pending, at(105))
    assert COMPLETION not in shaped.holds and COMPLETION not in shaped.replacements
    # Срок тревоги вышел, скорую не вызвали: итог не ждёт срока (`report_wait`).
    shaped = world({ALARM: alarm}, pending, at(400))
    assert COMPLETION not in shaped.holds and COMPLETION not in shaped.replacements

    snapshot = journal(presented={alarm_line: 101}, firings={ALARM: 100}, calls=calls)
    shaped = world({ALARM: alarm}, snapshot, at(130))
    [completion] = [
        item
        for item in apply_world([report(COMPLETION, 80)], shaped, set())
        if item.identity[0] == COMPLETION
    ]
    assert completion.ready_at == at(145)
    assert shaped.replacements[COMPLETION] == taken


ALREADY_LINE = line(20, "Понял, скорую ждём, встретим.")
SURPRISE_LINE = line(21, "Скорая подъехала. Хорошо, конечно, но могли бы и сказать, что вызвали.")
REQUEST_AHEAD = {
    **REQUEST_EVENT,
    "reply_options": list(REPLY_OPTIONS),
    "branches": {
        "already": {"line": ALREADY_LINE, "effects": []},
        "surprise": {"line": SURPRISE_LINE, "effects": []},
    },
}
EVENTS = {REQUEST: REQUEST_AHEAD, NUDGE: NUDGE_EVENT}
ASK = UUID(REQUEST_EVENT["line"]["id"])
# Карточка принята в 5 с, 103 набран в 10 с, бригада просит в 53 с, срок — 60 с.
PRECALL = call(10, ext="103", brigade=None)


def state(
    *,
    calls: list[dict[str, Any]],
    said: list[tuple[float, str]] = (),
    presented: dict[UUID, float] | None = None,
    replies: dict[UUID, list[tuple[float, str]]] | None = None,
) -> Journal:
    base = journal(
        statuses=[("accepted", 5)],
        presented={WORKS: 50, **(presented or {})},
        calls=[*DISPATCHED, *calls],
        firings={REQUEST: 53},
        replies=replies,
    )
    return replace(base, said={CREW: [{"at": at(s).isoformat(), "text": t} for s, t in said]})


def texts(journal_: Journal, now: float) -> list[tuple[str, float]]:
    return [
        (item.message["text"], (item.ready_at - at(0)).total_seconds())
        for item in world(EVENTS, journal_, at(now)).lines
    ]


def test_a_called_and_told_brigade_does_not_ask():
    told = state(calls=[PRECALL], said=[(12, "Скорую вызвал, едет")])
    assert texts(told, 54) == []
    # Доклад о завершении не задержан и не подменён: событие решено в момент срабатывания.
    [completion] = apply_world([report(COMPLETION, 40)], world(EVENTS, told, at(54)), set())
    assert (completion.ready_at, completion.planned["message"]["text"]) == (at(40), "доклад")
    # Страховочная «скорая будет?» не нужна.
    assert due_events(list(EVENTS.values()), told, {CREW}, at(200)) == []


def test_a_news_before_dialing_the_service_does_not_count():
    """Весть засчитывается только после набора номера службы — как у вести по просьбе
    (HQ-055): «скорую вызвал» до звонка — неправда, бригада всё равно просит."""
    before = state(calls=[PRECALL], said=[(8, "Скорую вызвал, едет")])
    assert texts(before, 54) == [(REQUEST_EVENT["line"]["text"], 53)]
    # Сказал в момент набора и позже — засчитано.
    at_dial = state(calls=[PRECALL], said=[(10, "Скорую вызвал, едет")])
    assert texts(at_dial, 54) == []


def test_a_needs_the_service_named_before_the_ask():
    vague = state(calls=[PRECALL], said=[(12, "Уже вызвал")])
    assert texts(vague, 54) == [(REQUEST_EVENT["line"]["text"], 53)]


@pytest.mark.parametrize(
    ("replies", "said"),
    [({ASK: [(58, "already")]}, ()), (None, ((58, "Да уже едут, ждите"),))],
)
def test_b_called_not_told_brigade_asks_and_hears_already(replies, said):
    asked = state(calls=[PRECALL], said=list(said), presented={ASK: 55}, replies=replies)
    assert texts(asked, 59) == [
        (REQUEST_EVENT["line"]["text"], 53),
        (ALREADY_LINE["text"], 58),
    ]


def test_b_untold_service_arrives_as_surprise_even_if_ask_unheard():
    silent = state(calls=[PRECALL])
    assert texts(silent, 100) == [(REQUEST_EVENT["line"]["text"], 53)]
    assert texts(silent, 114) == [
        (REQUEST_EVENT["line"]["text"], 53),
        (SURPRISE_LINE["text"], 113),
    ]
    assert due_events(list(EVENTS.values()), silent, {CREW}, at(200)) == []


def test_c_not_called_brigade_asks_and_nudges_as_before():
    nothing = state(calls=[])
    assert texts(nothing, 114) == [(REQUEST_EVENT["line"]["text"], 53)]
    [(nudge, fired)] = due_events(list(EVENTS.values()), nothing, {CREW}, at(114))
    assert (nudge["id"], fired) == (str(NUDGE), at(113))


MET_LINE = line(22, "Понял.")
CALLED_EVENTS = {
    REQUEST: {
        **REQUEST_AHEAD,
        "branches": {
            **REQUEST_AHEAD["branches"],
            "met": {"line": MET_LINE, "effects": []},
            # Просьба держит итог: без скорой он другой.
            "missed": {
                "line": None,
                "effects": [{"replace": str(COMPLETION), "with": line(23, "Скорой нет.")}],
            },
        },
    },
    NUDGE: NUDGE_EVENT,
}
# По просьбе (53 с) позвонили в 103 в 60 с, отбой в 70 с: служба на месте в 90 с.
ON_REQUEST = call(60, ext="103", brigade=None, answered=62, ended=70)


@pytest.mark.parametrize(
    ("said", "now", "expected"),
    [
        # Позвонил в службу — бригада не перезванивает ради «Понял» (HQ-055).
        ((), 80, []),
        # Сообщил: «отправил» — ответ «Понял, ждём» говорит окно телефона, мир молчит.
        (((75, "Отправил, ждите"),), 120, []),
        # Не сообщил к приезду службы — «подъехала, могли бы и сказать».
        ((), 91, [(SURPRISE_LINE["text"], 90)]),
        # «Уже вызвал» до набора номера службы — неправда, не весть: служба «внезапно».
        (((58, "Скорую уже вызвал"),), 91, [(SURPRISE_LINE["text"], 90)]),
    ],
)
def test_d_called_on_request_brigade_hears_news_from_dispatcher(said, now, expected):
    asked = state(calls=[ON_REQUEST], said=list(said), presented={ASK: 55})
    lines = [
        (item.message["text"], (item.ready_at - at(0)).total_seconds())
        for item in world(CALLED_EVENTS, asked, at(now)).lines
    ]
    assert lines == [(REQUEST_EVENT["line"]["text"], 53), *expected]


def test_d_report_after_request_waits_for_news():
    """Доклад, который просьба держит, звучит, когда решилось, сообщили ли бригаде: после
    «подъехала» — не раньше."""
    asked = state(calls=[ON_REQUEST], presented={ASK: 55})
    completion = apply_world([report(COMPLETION, 40)], world(CALLED_EVENTS, asked, at(85)), set())
    assert completion[0].ready_at == at(90)
    told = state(calls=[ON_REQUEST], said=[(75, "Скорая едет")], presented={ASK: 55})
    completion = apply_world([report(COMPLETION, 40)], world(CALLED_EVENTS, told, at(85)), set())
    # Сообщили в 75 с — приезд всё равно через 20 с после отбоя службе (70 с).
    assert completion[0].ready_at == at(90)


def test_after_repeat_and_confirmation_arrival_then_completion_are_ready():
    """Повтор не создаёт новую выдачу: после «Принял» приходят приезд службы и итог."""
    snapshot = state(calls=[ON_REQUEST], presented={ASK: 55})
    snapshot = replace(snapshot, turns=[Turn(CREW, at(55), at(85))])
    # У просьбы нет ни delay, ни replace: продолжение выводится из порядка плана.
    events = {REQUEST: REQUEST_AHEAD}
    issued = {(ASK, 1)}
    shaped = world(events, snapshot, at(91), following={WORKS: COMPLETION})
    ready = [
        item
        for item in apply_world([report(COMPLETION, 80)], shaped, issued)
        if not item.issued and item.ready_at is not None and item.ready_at <= at(91)
    ]
    ready.sort(key=delivery_order)
    assert [item.identity[0] for item in ready] == [UUID(SURPRISE_LINE["id"]), COMPLETION]
    assert all(item.ready_at == at(90) for item in ready)
    # После выдачи приезда итог остаётся готовым и не отодвигается каждым тиком мира.
    issued.add((UUID(SURPRISE_LINE["id"]), 1))
    shaped = world(events, snapshot, at(300), following={WORKS: COMPLETION})
    remaining = [
        item for item in apply_world([report(COMPLETION, 80)], shaped, issued) if not item.issued
    ]
    assert [item.identity[0] for item in remaining] == [COMPLETION]
    assert remaining[0].ready_at == at(90)


def test_call_before_acceptance_is_not_ahead():
    early = state(calls=[call(2, ext="103", brigade=None)], said=[(3, "Скорую вызвал")])
    assert texts(early, 54) == [(REQUEST_EVENT["line"]["text"], 53)]


# --- Загрузчик: ветки и варианты ответа по умолчанию ----------------------------------------


def test_loader_adds_already_surprise_and_options_from_bank():
    data = with_service_defaults(scenario_file("gas-entrance-104-2"))
    [event] = [item for item in data["events"] if item["kind"] == "request_service"]
    assert event["reply_options"] == list(REPLY_OPTIONS)
    assert event["branches"]["already"]["line"]["text"].startswith("Понял, пожарных ждём")
    assert event["branches"]["surprise"]["line"]["text"].startswith("Пожарные подъехали.")
    assert event["branches"]["surprise"]["effects"] == event["branches"]["met"]["effects"]
    # Исходный файл не меняется; явные ветки файла главнее.
    raw = scenario_file("gas-entrance-104-2")
    raw["events"][0]["branches"]["already"] = {"line": None, "effects": []}
    assert with_service_defaults(raw)["events"][0]["branches"]["already"]["line"] is None


def test_loader_names_rescuers_like_the_request():
    data = with_service_defaults(scenario_file("traffic-blocked-102-1"))
    rescue = next(item for item in data["events"] if item["key"] == "rescue")
    assert "спасател" in rescue["branches"]["already"]["line"]["text"].lower()
    assert "Спасатели" in rescue["branches"]["surprise"]["line"]["text"]


# --- С БД: через API ------------------------------------------------------------------------

CODE = "gas-entrance-104-2"


def walk(shift: Shift, on_event) -> None:
    """Карточка по плану до закрытия; на просьбе о службе — `on_event`."""
    plan = shift.data["plan"]
    for index, report_ in enumerate(plan):
        shift.hear([f"message:{report_['key']}"], 100 if report_["key"] == "completion" else 7)
        if report_["key"] == "works":
            time.sleep(3.2)  # просьба — через 3 с после доклада о работах
            on_event(shift)
        if index < len(plan) - 1:
            shift.status(report_["justifies_state"], "Доклад бригады принят")
            continue
        shift.hang_up()
        shift.status("completed", shift.data["reference"]["expected_comment"])


def start(shift: Shift, *, tell: bool) -> None:
    """Принята → вызвал пожарных через 112 → вводная бригаде (и «пожарных вызвал»)."""
    shift.open()
    shift.accept()
    shift.dial("112")
    shift.brief()
    if tell:
        shift.send("brigade_said", {"call_id": shift.call_id, "text": "Пожарных вызвал, едут"})


def no_ask(shift: Shift) -> None:
    worker_tick(shift.url, datetime.now(UTC))
    ids = {m["delivery"]["message"]["id"] for m in shift.messages()}
    assert shift.message_id("event:evacuation") not in ids


def answer_already(shift: Shift) -> None:
    ask = shift.hear(["event:evacuation"])
    keys = [option["key"] for option in ask["delivery"]["reply_options"]]
    assert keys == ["already", "calling"]
    shift.reply(ask, "already")
    # Ответ — в том же разговоре, без тика worker.
    texts_ = [m["delivery"]["message"]["text"] for m in shift.messages()]
    assert any(text.startswith("Понял, пожарных ждём") for text in texts_), texts_


def stay_silent(shift: Shift) -> None:
    ask = shift.hear(["event:evacuation"])
    # Окно телефона знает, что служба уже вызвана: звонок в 112 в выдаче, у просьбы — окно
    # вести от того звонка до срока ответа (GP-28, как у вести по просьбе, HQ-055).
    body = shift.client.get(f"/api/cards/{shift.card_id}/training").json()
    assert [call["service_id"] for call in body["service_calls"]] == ["112"]
    [delivery] = [
        item["delivery"]
        for item in body["messages"]
        if item["delivery"]["delivery_id"] == ask["delivery"]["delivery_id"]
    ]
    assert delivery["service_called_at"] == body["service_calls"][0]["started_at"]
    assert delivery["news_by"] > delivery["delivered_at"]
    surprise = shift.hear(["event:evacuation:surprise"], 40)
    assert surprise["delivery"]["message"]["text"].startswith("Пожарные подъехали.")


@pytest.mark.parametrize(
    ("tell", "on_event", "score", "line_"),
    [
        (True, no_ask, 1.0, "не понадобилось: служба вызвана заранее и бригада предупреждена"),
        (False, answer_already, 1.0, "на просьбу ответили вариантом, что служба уже едет"),
        (False, stay_silent, 0.9, "Замечание: не сообщил бригаде, что служба вызвана."),
    ],
    ids=["a-told", "b-already", "b-surprise"],
)
def test_service_called_ahead_through_api(
    tell, on_event, score, line_, database_config, database_url, request
):
    seed_training(database_url)
    shift = open_shift(database_config, database_url, request, CODE)
    start(shift, tell=tell)
    walk(shift, on_event)
    evaluation = shift.evaluation()
    lines = explanation(evaluation, "brigade_work")
    assert any(line_ in item for item in lines), lines
    # Верный повод первой полной вводной — отдельный вклад 1 в среднее;
    # прежний балл реакции на просьбу о службе остаётся score.
    assert float(evaluation.rules_scores["brigade_work"]) == pytest.approx((1.0 + score) / 2)
    assert "brigade_work" not in evaluation.critical_flags


# --- «ДТП: на месте загорелась машина» (102): живая проверка пользователя 17.10 ------------

FIRE = "traffic-fire-102-2"
FIRE_DONE = "Пожарные машину потушили, полосу освободили. Работы закончили, наряд освободился."
FIRE_BURNT = (
    "Пожарных не дождались, тушили огнетушителями сами — машина выгорела. Полосу освободили, "
    "наряд свободен."
)


def fire_shift(database_config, database_url, request, monkeypatch) -> Shift:
    from . import test_final_scenarios as final

    monkeypatch.setitem(final.SEATS, FIRE, ("102", "trainee01"))
    seed_training(database_url)
    shift = open_shift(database_config, database_url, request, FIRE)
    shift.open()
    shift.accept()
    shift.brief()
    for key, state_ in (("departure", "responding"), ("arrival", "arrived")):
        shift.hear([f"message:{key}"], 7)
        shift.status(state_, "Доклад экипажа принят")
    shift.hear(["message:works"], 7)
    shift.status("working", "Под капотом загорелось, нужны пожарные")
    return shift


def call_crew_back(shift: Shift, text: str) -> None:
    """Отбой, звонок в 112 о пожаре, снова звонок экипажу: «пожарные выехали»."""
    shift.hang_up()
    shift.dial("112")
    brigade = uuid5(NAMESPACE_URL, f"arm112:c04:{shift.service}:brigade:0")
    target = uuid5(NAMESPACE_URL, f"arm112:c04:{shift.service}:target:0")
    call_id = str(uuid4())
    shift.send(
        "call_dial_target",
        {"call_id": call_id, "call_target_id": str(target), "brigade_id": str(brigade)},
    )
    shift.send("call_answer", {"call_id": call_id})
    shift.call_id = call_id
    shift.send("brigade_said", {"call_id": call_id, "text": text})


def close(shift: Shift, names: list[str]) -> dict[str, Any]:
    done = shift.hear(names, 100)
    shift.hang_up()
    shift.status("completed", shift.data["reference"]["expected_comment"])
    return done


def test_fire_called_and_crew_told_no_ask_and_firefighters_in_report(
    database_config, database_url, request, monkeypatch
):
    shift = fire_shift(database_config, database_url, request, monkeypatch)
    call_crew_back(shift, "Пожарные выехали")
    # Срок просьбы прошёл: экипаж так и не спросил — его предупредили.
    worker_tick(shift.url, datetime.now(UTC) + timedelta(seconds=11))
    ids = {m["delivery"]["message"]["id"] for m in shift.messages()}
    assert shift.message_id("event:firefighters") not in ids
    done = close(shift, ["message:completion"])
    assert done["delivery"]["message"]["text"] == FIRE_DONE
    lines = explanation(shift.evaluation(), "brigade_work")
    assert any("служба вызвана заранее и бригада предупреждена" in item for item in lines), lines


def test_fire_not_called_crew_asks_twice_and_car_burns(
    database_config, database_url, request, monkeypatch
):
    shift = fire_shift(database_config, database_url, request, monkeypatch)
    ask = shift.hear(["event:firefighters"], 11)
    assert [o["key"] for o in ask["delivery"]["reply_options"]] == ["already", "calling"]
    shift.hear(["event:firefighters-again"], 45)
    done = close(shift, ["event:firefighters-again:missed-replace"])
    assert done["delivery"]["message"]["text"] == FIRE_BURNT
    evaluation = shift.evaluation()
    # Просьба о пожарных по-прежнему провалена (0), но верная вводная
    # даёт независимый вклад 1; общий балл — среднее двух действий.
    assert float(evaluation.rules_scores["brigade_work"]) == pytest.approx((1.0 + 0.0) / 2)
    lines = explanation(evaluation, "brigade_work")
    assert any("в 112 или 101 не позвонили" in item for item in lines), lines


def test_called_on_request_dispatcher_tells_crew(database_config, database_url, request):
    """HQ-055: «сейчас вызову» → звонок в 112 → диспетчер перезванивает: «отправил». Бригада
    не перезванивает ради «Понял», пожарные не приезжают «внезапно», в разборе — сообщили."""
    seed_training(database_url)
    shift = open_shift(database_config, database_url, request, CODE)
    shift.open()
    shift.accept()
    shift.brief()

    def call_and_tell(shift: Shift) -> None:
        ask = shift.hear(["event:evacuation"])
        # Окно телефона знает, о какой службе «отправил» без названия.
        assert ask["delivery"]["needs_service"] == "101"
        shift.reply(ask, "calling")
        call_crew_back(shift, "Отправил, ждите")
        # Окно вести для окна телефона: «Понял, ждём» — только после набора службы и до срока.
        delivery = next(
            m["delivery"]
            for m in shift.messages()
            if m["delivery"]["message"]["id"] == shift.message_id("event:evacuation")
        )
        assert "service_called_at" in delivery
        worker_tick(shift.url, datetime.now(UTC) + timedelta(seconds=45))
        ids = {m["delivery"]["message"]["id"] for m in shift.messages()}
        assert shift.message_id("event:evacuation:met") not in ids
        assert shift.message_id("event:evacuation:surprise") not in ids

    walk(shift, call_and_tell)
    lines = explanation(shift.evaluation(), "brigade_work")
    assert any("сообщили бригаде, что служба едет" in item for item in lines), lines
