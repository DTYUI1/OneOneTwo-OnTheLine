"""Инварианты прогона связности ловят живые несостыковки 17.10 (HQ-028).

Живой звонок, pipe-basement-104-2: «бригада выехала» → повтор адреса «…выезжаем!» → второй
вопрос поверх первого → «Прибыли» → «разворачиваемся». Движок такого больше не выдаёт
(прогон связности по сценарию чистый); эти тесты держат, что прогон заметит, если выдаст.
"""

import json
from typing import Any

from app.core.config import ROOT
from app.tools.coherence.invariants import check
from app.tools.coherence.transcript import Line, Source, Transcript

CODE = "pipe-basement-104-2"


def scenario() -> dict[str, Any]:
    path = ROOT / "data" / "scenarios" / f"{CODE}.json"
    return json.loads(path.read_text(encoding="utf-8"))


def say(
    at: float,
    text: str,
    source: Source,
    key: str | None = None,
    *,
    options: bool = False,
) -> Line:
    meta = {"options": ["fix", "ok"]} if options else {}
    who = "Вы" if source == "dispatcher" else "Бригада 1"
    return Line(at, "speech", who, text, source, end=at + 2.5, call="c1", key=key, meta=meta)


def transcript(lines: list[Line]) -> Transcript:
    tr = Transcript(CODE, "живой звонок", "104", lines=lines)
    tr.data["scenario"] = scenario()
    return tr


def rules(tr: Transcript) -> set[str]:
    return {item.rule for item in check(tr)}


def live_call_17_10() -> list[Line]:
    """Расшифровка из задачи HQ-028, как её записал бы прогон."""
    data = scenario()
    events = {event["key"]: event for event in data["events"]}
    readback, entrance = events["readback"], events["entrance"]
    return [
        say(10, "Понял, бригада выехала.", "plan", "departure"),
        say(14, readback["line"]["text"], "event", "readback", options=True),
        say(17.5, entrance["line"]["text"], "event", "entrance", options=True),
        say(21, "Вход в подвал у четвёртого подъезда.", "dispatcher"),
        say(24, entrance["branches"]["met"]["line"]["text"], "branch", "entrance:met"),
        say(27, "Поправка по адресу: улица Пришвина, 17.", "dispatcher"),
        say(30, "Прибыли. Подвал залит по колено…", "plan", "arrival"),
        say(33, readback["branches"]["met"]["line"]["text"], "branch", "readback:met"),
    ]


def test_live_call_17_10_breaks_three_rules():
    found = check(transcript(live_call_17_10()))
    texts = {(item.rule, item.at) for item in found}
    # «…выезжаем!» после «бригада выехала».
    assert ("stage_regress", 14) in texts
    # «Подъезд какой?» через 1 с после вопроса о повторе адреса, без ответа.
    assert ("talks_over_question", 17.5) in texts
    # «Понял поправку, разворачиваемся» после «Прибыли»: и этап, и ответ после доклада,
    # который событие держит или подменяет.
    assert ("stage_regress", 33) in texts
    assert ("answer_after_target", 33) in texts


def test_checker_passes_the_same_call_in_proper_order():
    """Проверяльщик не придирается к связному порядку тех же реплик (расшифровка ручная, не
    вывод движка): повтор адреса — сам доклад о выезде, вопросы — по одному, ответ ветки — до
    прибытия. Порядок вывода движка держат тесты `test_live_brigade.py` (HQ-028)."""
    data = scenario()
    events = {event["key"]: event for event in data["events"]}
    readback, entrance = events["readback"], events["entrance"]
    tr = transcript(
        [
            say(15, readback["line"]["text"], "plan", "departure", options=True),
            say(22.7, "Поправка по адресу: улица Пришвина, 17", "dispatcher"),
            say(25.7, readback["branches"]["met"]["line"]["text"], "branch", "readback:met"),
            say(28.7, entrance["line"]["text"], "event", "entrance", options=True),
            say(35.7, "Вход в подвал у четвёртого подъезда", "dispatcher"),
            say(38.5, entrance["branches"]["met"]["line"]["text"], "branch", "entrance:met"),
            say(40.7, data["plan"][1]["line"]["text"], "plan", "arrival"),
        ]
    )
    assert not rules(tr) & {"stage_regress", "talks_over_question", "answer_after_target"}


# --- HQ-058: эталон отвечает «Принял» на каждое «Как приняли?» -----------------------------


def reference(lines: list[Line]) -> Transcript:
    tr = transcript(lines)
    tr.policy = "эталон"
    return tr


def asked_after_hold() -> list[Line]:
    """Доклад во входящем, «Как приняли?», удержание (звонок в службу), снятие, переспрос."""
    data = scenario()
    report = say(10, data["plan"][1]["line"]["text"], "plan", "arrival")
    report.meta = {"inbound": True}
    service = Line(16, "speech", "Служба 103", "Слушаю.", "service", end=17, call="s1")
    return [
        report,
        say(12.5, "Как приняли?", "client", "confirm_request"),
        service,
        say(20, "Как приняли?", "client", "confirm_request"),
    ]


def test_reference_without_confirm_after_hold_breaks_rule():
    found = [
        item for item in check(reference(asked_after_hold())) if item.rule == "confirm_unanswered"
    ]
    # Ни первое «Как приняли?», ни переспрос после удержания без «Принял».
    assert [item.at for item in found] == [12.5, 20]


def test_reference_confirm_after_repeat_passes():
    lines = [*asked_after_hold(), say(23, "Принял.", "dispatcher", "confirm")]
    assert "confirm_unanswered" not in rules(reference(lines))


def test_confirm_rejected_by_server_breaks_rule():
    lines = [*asked_after_hold(), say(23, "Принял.", "dispatcher", "confirm")]
    tr = reference(lines)
    tr.errors.append("23.0 с: report_confirmed → 409 {}")
    assert "confirm_unanswered" in rules(tr)


def test_other_policies_may_leave_confirm_unanswered():
    """Не подтверждает — отклонение обучаемого («не_подтверждает»), не несостыковка мира."""
    assert "confirm_unanswered" not in rules(transcript(asked_after_hold()))


def test_answered_twice_on_readback_fix_by_phrase():
    """Поправка фразой (HQ-024): «Принял» окна телефона и следом ответ ветки — два ответа;
    приезд службы без вести (`surprise`) и повтор доклада на «Доложите» — не такие ответы."""
    fix = say(20, "Нет, улица Пришвина, 17.", "dispatcher")
    ack = say(23, "Принял.", "client", "ack")
    met = say(26, "Принял поправку.", "branch", "readback:met")
    met.meta["answer"] = True
    assert "answered_twice" in rules(transcript([fix, ack, met]))
    surprise = say(26, "Скорая подъехала, могли бы и сказать.", "branch", "ambulance:surprise")
    surprise.meta["answer"] = True
    assert "answered_twice" not in rules(transcript([fix, ack, surprise]))
    ask = say(20, "Доложите обстановку.", "dispatcher")
    repeat = say(23, "Повторяю. Подвал залит.", "client", "report_request")
    assert "answered_twice" not in rules(transcript([ask, repeat, met]))
    # Два ответа ветки подряд — на два разных вопроса бригады.
    floor = say(23, "Понял, поднимаемся.", "branch", "floor:met")
    floor.meta["answer"] = True
    assert "answered_twice" not in rules(transcript([fix, floor, met]))
    # Ответ вариантом и сразу вторая фраза: «Принял» окна — на фразу, ветка — на вариант.
    option = say(20, "Поправка по адресу: улица Пришвина, 17.", "dispatcher", "reply:fix")
    again = say(21, "Выезжайте.", "dispatcher")
    assert "answered_twice" not in rules(transcript([option, again, ack, met]))
    assert "answered_twice" not in rules(transcript([fix, again, ack, met]))
