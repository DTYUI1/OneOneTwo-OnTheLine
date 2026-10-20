"""TC-10: замечание разбора — цитата, последствие, страница памятки, «Повторите: …».

Нормализация перед сверкой (ё → е, «ул.» → «улица», «д. 21» = «дом 21», латинские
двойники), детектор прокликивания (статусы подряд быстрее порога — «карточку не читали»,
без снижения балла), вопрос к данным (ошибка сценария не вменяется) и помощь без штрафа.
"""

import copy
import json
import re
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from evalcore.address import cyrillic_twins, normalize_address_component
from evalcore.brigade import BrigadeWorkCriterion
from evalcore.criteria import (
    AddressCriterion,
    CallCriterion,
    RequiredFieldsCriterion,
    RoutingCriterion,
    StatusFlowCriterion,
)
from evalcore.defaults import BRIGADE_WEIGHTS, CLICKTHROUGH_S
from evalcore.models import EvalContext, Json, Remark
from evalcore.remarks import QUOTE_RADIUS, default_remarks, fold, quote, quote_word
from evalcore.scoring import evaluate

GOLDEN = Path(__file__).parents[3] / "data" / "golden_scenarios" / "case-01.json"
FIXTURE = json.loads(GOLDEN.read_text(encoding="utf-8"))
T0 = datetime(2026, 9, 19, 9, 0, tzinfo=UTC)
# Страницы памятки ДДС, на которые ссылаются замечания (правила статусов — с. 21–32).
MEMO_PAGES = range(21, 33)
LATIN = re.compile(r"[A-Za-z]{2,}")


def iso(seconds: float) -> str:
    return (T0 + timedelta(seconds=seconds)).isoformat()


def event(seconds: float, kind: str, payload: dict[str, Json] | None = None) -> dict[str, Json]:
    return {
        "client_event_id": f"00000000-0000-4000-8000-{int(seconds * 1000):012d}",
        "client_ts": iso(seconds),
        "server_ts": iso(seconds),
        "clock_offset_ms": 0,
        "type": kind,
        "payload": payload or {},
    }


def status(seconds: float, state: str, comment: str = "Принята, направлен экипаж.") -> dict:
    return event(seconds, "status_change", {"state": state, "comment": comment})


def context(**changes) -> EvalContext:
    fixture = copy.deepcopy(FIXTURE)
    ctx = EvalContext(
        scenario=fixture["scenario"],
        current=fixture["current"],
        events=fixture["events"],
        calls=fixture["calls"],
        settings=fixture["settings"],
    )
    return replace(ctx, **changes)


def written(comment: str) -> EvalContext:
    """Попытка, где в карточке и во всех комментариях к статусам — только этот текст."""
    events = [
        {**item, "payload": {**item["payload"], "comment": comment}}
        if item["type"] == "status_change"
        else item
        for item in copy.deepcopy(FIXTURE["events"])
    ]
    return context(events=events, current={"service_number": "1", "comment": comment})


def assert_remark(remark: Remark) -> None:
    """Замечание полное и по правилам текстов: последствие, страница, «Повторите», по-русски."""
    assert remark.text and remark.consequence
    assert remark.memo_page in MEMO_PAGES
    assert remark.repeat.startswith(("Повторите:", "Повторять не нужно"))
    for text in (remark.text, remark.consequence, remark.repeat):
        assert not LATIN.search(text), text
        for sentence in re.split(r"(?<=[.!?])\s+", text):
            assert len(sentence.split()) <= 20, sentence


# --- Цитата ------------------------------------------------------------------------------


def test_quote_ignores_case_yo_and_latin_twins():
    text = "Принята. Москва, ул. Солёная, дом 1. Экипаж выехал на Тверскaя-Ямскую."
    assert quote(text, "СОЛЕНАЯ") == text
    # 45 символов до найденного — по границе слова, начало обрезано.
    assert (
        quote(text, "тверская-ямскую") == "…ул. Солёная, дом 1. Экипаж выехал на Тверскaя-Ямскую."
    )
    assert quote(text, "Ленина") is None
    assert quote(text, "   ") is None


def test_quote_is_45_characters_around_by_word_boundaries():
    before = "Слово " * 20
    after = " конец" * 20
    text = f"{before}Дубининская{after}"
    found = quote(text, "дубининская")
    assert found is not None
    assert found.startswith("…") and found.endswith("…")
    body = found.strip("…")
    assert "Дубининская" in body
    assert len(body) <= len("Дубининская") + 2 * QUOTE_RADIUS
    # Слова на краях не режутся.
    assert all(word in {"Слово", "Дубининская", "конец"} for word in body.split())


def test_quote_word_matches_only_whole_words():
    text = "Экипаж на Дубининской, а не на Дубининская-2"
    assert quote_word(text, "Дубининская") == text
    assert quote_word("Новодубининская улица", "Дубининская") is None


def test_fold_keeps_positions():
    text = "Ёлка ТВЕРСКAЯ Солёная"
    assert len(fold(text)) == len(text)
    assert fold(text) == "елка тверская соленая"


# --- Нормализация адреса ---------------------------------------------------------------------


@pytest.mark.parametrize(
    ("field", "left", "right"),
    [
        ("street", "ул. Солёная", "Соленая улица"),
        ("street", "Тверскaя улица", "ул. Тверская"),
        ("house", "д. 21", "дом 21"),
        ("house", "Д.21", "21"),
        ("apartment", "кв. 5", "квартира 5"),
    ],
)
def test_address_normalization_before_comparison(field, left, right):
    assert normalize_address_component(field, left) == normalize_address_component(field, right)


def test_latin_twins_only_inside_russian_words():
    assert cyrillic_twins("Тверскaя") == "Тверская"
    assert cyrillic_twins("MOSLIFT, SMS") == "MOSLIFT, SMS"


@pytest.mark.parametrize(
    "comment",
    [
        "Адрес уточнён: ул. Дубнинская, д. 1",
        "Адрес уточнён: Дубнинская улица, дом 1",
        "Адрес уточнён: дубнинская ул. дом 1",
        "Адрес уточнён: Дубнинскaя улица, д. 1",
    ],
)
def test_clarified_address_is_found_after_normalization(comment):
    ctx = written(comment)
    ctx.scenario["card"]["address"]["street"] = "Дубининская улица"
    result = AddressCriterion().evaluate(ctx)
    assert result.score == 1 and result.remarks == (), result.explanation


def test_clarified_address_without_street_says_what_to_write():
    ctx = written("Адрес уточнён: дом 1")
    ctx.scenario["card"]["address"]["street"] = "Дубининская улица"
    result = AddressCriterion().evaluate(ctx)
    (remark,) = result.remarks
    assert remark.text == "В комментарии нет уточнённого адреса: улица."
    assert remark.repeat.endswith("— Дубнинская улица, дом 1.")


def test_wrong_street_remark_quotes_the_comment():
    comment = "Принята. Экипаж направлен: Москва, Дубининская улица, дом 1, у магазина."
    ctx = written(comment)
    result = AddressCriterion().evaluate(ctx)
    assert result.critical
    (remark,) = result.remarks
    assert remark.text == "В комментарии другая улица — «Дубининская»."
    assert remark.quote is not None and "Дубининская улица, дом 1" in remark.quote
    assert "Дубнинская улица" in remark.repeat
    assert_remark(remark)


# --- Прокликивание ---------------------------------------------------------------------------


def flow(*items: dict) -> list[dict]:
    return [event(0, "deliver"), event(10, "open"), *items]


def test_status_right_after_open_is_a_notice_without_penalty():
    ctx = context(
        events=flow(status(11, "accepted"), status(20, "responding"), status(90, "completed"))
    )
    result = StatusFlowCriterion().evaluate(ctx)
    assert result.score == 1 and not result.critical
    (remark,) = result.remarks
    assert remark.kind == "notice"
    assert remark.text == (
        f"Статусы подряд быстрее {CLICKTHROUGH_S} секунд: «Принята» — через 1 с после "
        "открытия карточки. Похоже, карточку не читали."
    )
    assert_remark(remark)
    assert evaluate(ctx).total == evaluate(context()).total


def test_statuses_in_a_row_faster_than_threshold_are_noticed():
    ctx = context(
        events=flow(status(20, "accepted"), status(21, "responding"), status(90, "completed"))
    )
    (remark,) = StatusFlowCriterion().evaluate(ctx).remarks
    assert "«Начало реагирования» — через 1 с после «Принята»" in remark.text


def test_reading_the_card_is_not_clickthrough():
    ctx = context(
        events=flow(
            status(10 + CLICKTHROUGH_S, "accepted"),
            # Вернулся к прочитанной карточке — сразу статус: не прокликивание.
            event(30, "open"),
            status(30.5 + CLICKTHROUGH_S, "responding"),
            status(90, "completed"),
        )
    )
    assert StatusFlowCriterion().evaluate(ctx).remarks == ()


def test_clickthrough_uses_browser_clock_not_server_burst():
    # Очередь событий ушла на сервер пачкой после обрыва связи: server_ts почти одинаковые.
    items = flow(status(20, "accepted"), status(30, "responding"), status(90, "completed"))
    burst = [{**item, "server_ts": iso(95 + index * 0.1)} for index, item in enumerate(items)]
    assert StatusFlowCriterion().evaluate(context(events=burst)).remarks == ()


# --- Замечания у каждой ошибки ------------------------------------------------------------


def test_missing_and_premature_statuses_have_consequences():
    missing = context(events=flow(status(20, "accepted"), status(90, "completed")))
    (remark,) = StatusFlowCriterion().evaluate(missing).remarks
    assert remark.text == "Не поставлен статус «Начало реагирования»."
    assert "служба не реагирует" in remark.consequence and remark.memo_page == 31
    assert_remark(remark)

    planned = (
        {"message_id": "m1", "justifies_state": "responding", "presented_at": iso(40)},
        {"message_id": "m2", "justifies_state": "completed", "presented_at": iso(80)},
    )
    early = context(
        events=flow(status(20, "accepted"), status(30, "responding"), status(90, "completed")),
        planned_messages=planned,
    )
    result = StatusFlowCriterion().evaluate(early)
    assert result.critical
    assert result.remarks[0].text == "Статус «Начало реагирования» поставлен до доклада бригады."
    assert "вводит в заблуждение" in result.remarks[0].consequence
    for item in result.remarks:
        assert_remark(item)


def test_completed_instead_of_refused():
    ctx = context(
        events=flow(status(20, "accepted"), status(30, "responding"), status(90, "completed"))
    )
    ctx.scenario["reference"]["expected_flow"] = ["received", "accepted", "responding", "refused"]
    (remark,) = StatusFlowCriterion().evaluate(ctx).remarks
    assert remark.text == "Карточка закрыта «Работы завершены», а работ на месте не было."
    assert "«Отказ от выполнения работ»" in remark.repeat and remark.memo_page == 22


def test_own_card_rejected_quotes_the_reason():
    reason = "Не наша территория, информация передана в управу района."
    ctx = context(events=flow(status(20, "rejected", reason)))
    result = RoutingCriterion().evaluate(ctx)
    (remark,) = result.remarks
    assert remark.consequence.startswith("Служба не оповещена — фактически не выехала")
    assert remark.quote == reason
    assert_remark(remark)


def test_empty_required_fields_and_missing_call():
    fields = RequiredFieldsCriterion().evaluate(
        context(current={"service_number": "", "comment": ""})
    )
    assert [item.text for item in fields.remarks] == [
        "Не заполнен «Номер наряда».",
        "Комментарий не заполнен.",
    ]
    assert fields.remarks[0].memo_page == 24
    call = CallCriterion().evaluate(context(calls=[]))
    (remark,) = call.remarks
    assert remark.text == "Обязательного звонка не было." and remark.memo_page == 32
    assert "по номеру 102" in remark.repeat
    for item in (*fields.remarks, *call.remarks):
        assert_remark(item)


def test_every_lost_point_has_a_remark():
    ctx = context(
        events=flow(status(11, "rejected", "Не наша"), status(60, "completed")),
        calls=[],
        current={"service_number": "", "comment": "Дубининская улица, дом 1"},
    )
    result = evaluate(ctx)
    lost = [item for item in result.criteria if item.weight > 0 and item.score < 1]
    assert {item.key for item in lost} >= {
        "status_flow",
        "routing",
        "required_fields",
        "address",
        "call",
    }
    for item in lost:
        errors = [remark for remark in item.remarks if remark.kind == "error"]
        assert errors, item.key
        for remark in item.remarks:
            assert_remark(remark)


def test_default_remarks_for_old_evaluations_and_judge():
    (remark,) = default_remarks("comment_completeness", 0.5, "Нет сведений о пострадавших.")
    assert remark.text == "Нет сведений о пострадавших."
    assert_remark(remark)
    assert default_remarks("routing", 1.0, "ok") == ()
    assert default_remarks("unknown", 0.0, "x") == ()


# --- Вопрос к данным -----------------------------------------------------------------------


def test_expected_status_without_report_in_plan_is_a_data_question():
    planned = (
        {"message_id": "m1", "justifies_state": "responding", "presented_at": iso(15)},
        {"message_id": "m2", "justifies_state": "completed", "presented_at": iso(80)},
    )
    reference = copy.deepcopy(FIXTURE["scenario"]["reference"])
    reference["expected_flow"] = ["received", "accepted", "responding", "arrived", "completed"]
    for actual in (
        flow(status(15, "accepted"), status(20, "responding"), status(90, "completed")),
        flow(
            status(15, "accepted"),
            status(20, "responding"),
            status(30, "arrived"),
            status(90, "completed"),
        ),
    ):
        ctx = context(events=actual, planned_messages=planned)
        ctx.scenario["reference"] = reference
        result = StatusFlowCriterion().evaluate(ctx)
        assert result.score == 1 and not result.critical
        (remark,) = result.remarks
        assert remark.kind == "data"
        assert remark.text.startswith("Вопрос к данным: эталон ждёт статус «Прибытие»")
        assert_remark(remark)


def test_status_set_by_report_but_not_in_reference_is_a_data_question():
    planned = (
        {"message_id": "m1", "justifies_state": "responding", "presented_at": iso(15)},
        {"message_id": "m2", "justifies_state": "arrived", "presented_at": iso(25)},
        {"message_id": "m3", "justifies_state": "completed", "presented_at": iso(80)},
    )
    ctx = context(
        events=flow(
            status(14, "accepted"),
            status(20, "responding"),
            status(30, "arrived"),
            status(90, "completed"),
        ),
        planned_messages=planned,
    )
    result = StatusFlowCriterion().evaluate(ctx)
    assert result.score == 1 and not result.critical
    (remark,) = result.remarks
    assert remark.kind == "data"
    assert remark.text == (
        "Вопрос к данным: статус «Прибытие» поставлен по докладу бригады, но эталон сценария "
        "его не ждёт."
    )
    assert_remark(remark)


def test_brigade_event_without_needed_option_is_not_charged():
    event_ = {
        "kind": "clarify",
        "brigade_id": "b1",
        "trigger": {"on": "message", "message_id": "m1", "after_s": 2},
        "line": {"id": "l1", "version": 1, "text": "На каком этаже?", "audio": None},
        "expect": [{"action": "reply", "option_key": "floor_9", "within_s": 40}],
        "reply_options": [{"key": "unknown", "label": "Не знаю"}],
        "branches": {},
        "review": {"label": "Расчёт спросил этаж", "critical": True},
    }
    fired = {
        "event": event_,
        "fired_at": iso(20),
        "source": "inject",
        "presented_at": iso(21),
        "replies": [],
    }
    settings = {
        **FIXTURE["settings"],
        "weights": {**FIXTURE["settings"]["weights"], **BRIGADE_WEIGHTS},
    }
    result = BrigadeWorkCriterion().evaluate(context(scenario_events=(fired,), settings=settings))
    assert not result.critical
    (remark,) = result.remarks
    assert remark.kind == "data" and "нет нужного «floor_9»" in remark.text


# --- Помощь без штрафа --------------------------------------------------------------------


def test_hints_are_not_penalized():
    base = evaluate(context())
    hinted = context(
        events=[
            *FIXTURE["events"],
            event(12, "hint_open", {"hint_id": "status"}),
            event(13, "hint_open", {"hint_id": "tutor:accepted"}),
        ]
    )
    result = evaluate(hinted)
    assert result.total == base.total
    assert [(item.key, item.score, item.remarks) for item in result.criteria] == [
        (item.key, item.score, item.remarks) for item in base.criteria
    ]
