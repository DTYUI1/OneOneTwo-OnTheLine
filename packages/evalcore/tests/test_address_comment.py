"""Адрес в комментарии ДДС (DT-14, 08.10): поле ввода адреса из АРМ ДДС убрано.

Адрес карточки верен — в комментарии его можно не писать, но нельзя исказить («Дубининская»
вместо «Дубнинская»). Адрес уточнён по ходу работы — уточнённый адрес нужен в комментарии.
Обычная запись адреса засчитывается, похожая другая улица — нет (29.09).
"""

import copy
import json
from pathlib import Path

import pytest
from evalcore.address import other_street
from evalcore.comment import house_said
from evalcore.criteria import AddressCriterion, address_clarified
from evalcore.models import EvalContext, Json

GOLDEN = Path(__file__).parents[3] / "data" / "golden_scenarios" / "case-01.json"
FIXTURE = json.loads(GOLDEN.read_text(encoding="utf-8"))


def context(
    comment: str, *, card_street: str | None = None, events: list[dict[str, Json]] | None = None
) -> EvalContext:
    scenario = copy.deepcopy(FIXTURE["scenario"])
    if card_street is not None:
        # Карточка оператора с ошибкой в улице; эталон — уточнённый адрес (Дубнинская).
        scenario["card"]["address"]["street"] = card_street
    return EvalContext(
        scenario=scenario,
        current={"service_number": "1", "comment": comment, "address": None},
        events=events or [],
        calls=[],
        settings=FIXTURE["settings"],
    )


def result(comment: str, **kwargs):
    return AddressCriterion().evaluate(context(comment, **kwargs))


@pytest.mark.parametrize(
    "comment",
    [
        "Москва, (Северный, Учебный) Дубнинская улица, 1 , бригада 1 службы 102-1 выехала",
        "Москва, Дубнинская ул., 1",
        "Москва, ул. Дубнинская, д. 1",
        "Москва, Дубнинская улица, дом 1",
    ],
)
def test_usual_address_records_are_accepted(comment):
    for checked in (result(comment), result(comment, card_street="Дубининская улица")):
        assert checked.score == 1 and not checked.critical, checked.explanation


def test_correct_card_address_need_not_be_repeated():
    checked = result("Принята, направлен экипаж 102-1. Пострадавших двое.")
    assert checked.score == 1 and not checked.critical
    assert "можно не повторять" in checked.explanation
    partial = result("Принята, экипаж выехал на Дубнинскую улицу")
    assert partial.score == 1 and not partial.critical


def test_distorted_street_is_critical_even_when_card_is_correct():
    for comment in (
        "Москва, Дубининская улица, 1",
        "Экипаж выехал, дубининская 1",
    ):
        checked = result(comment)
        assert checked.critical, comment
        assert checked.score == pytest.approx(2 / 3)
        assert "другая улица — «дубининская»" in checked.explanation.casefold()
        assert checked.evidence[-2] == "Не совпали: улица"


def test_distorted_house_is_critical_and_stray_number_is_not():
    wrong_house = result("Москва, Дубнинская улица, 12")
    assert wrong_house.critical and "дом" in wrong_house.explanation
    assert result("Дубнинская ул., д. 12").critical
    stray = result("Москва, Дубнинская улица, пострадавших 1")
    assert stray.score == 1 and not stray.critical


@pytest.mark.parametrize(
    "comment",
    [
        "Пожарный гидрант на ул. Ленина, рукавная линия проложена",
        "Жильцов эвакуировали в дом 14 напротив",
        "Принята, ул. Тверская, д. 1",
        "Дубнинская улица, 1. Жильцов эвакуировали в дом 14 напротив, гидрант на ул. Ленина",
    ],
)
def test_other_street_and_house_outside_address_are_not_errors(comment):
    """Ревью DT-14 (11.10): при верном адресе карточки соседняя улица и дом напротив —
    обстановка, а не искажённый адрес. Ошибка — только опечатка в улице и другой номер
    в записи адреса с улицей карточки."""
    checked = result(comment)
    assert checked.score == 1 and not checked.critical, checked.explanation


def test_wrong_apartment_counts_only_in_address_record():
    scenario = copy.deepcopy(FIXTURE["scenario"])
    for address in (scenario["card"]["address"], scenario["reference"]["expected_address"]):
        address["apartment"] = "47"

    def checked(comment: str):
        ctx = EvalContext(
            scenario=scenario,
            current={"service_number": "1", "comment": comment, "address": None},
            events=[],
            calls=[],
            settings=FIXTURE["settings"],
        )
        return AddressCriterion().evaluate(ctx)

    wrong = checked("Дубнинская ул., д. 1, кв. 74")
    assert wrong.score == pytest.approx(3 / 4) and not wrong.critical
    assert "квартира" in wrong.explanation
    neighbour = checked("Дубнинская ул., д. 1. Соседка из кв. 50 жалуется на дым")
    assert neighbour.score == 1 and not neighbour.critical


def test_clarified_address_must_be_in_comment():
    missing = result("Принята, экипаж направлен", card_street="Дубининская улица")
    assert missing.critical and missing.score == pytest.approx(1 / 3)
    assert "уточнённого адреса" in missing.explanation
    stray = result("Москва, Дубнинская улица, пострадавших 1", card_street="Дубининская улица")
    assert stray.critical and "дом" in stray.explanation
    card_street = result("Москва, Дубининская улица, дом 1", card_street="Дубининская улица")
    assert card_street.critical and "другая улица" in card_street.explanation


def test_address_in_earlier_status_comment_counts():
    events: list[dict[str, Json]] = [
        {
            "type": "status_change",
            "client_ts": "2026-10-08T09:00:10Z",
            "payload": {"state": "arrived", "comment": "Уточнённый адрес: Дубнинская ул., д. 1"},
        }
    ]
    checked = result("Работы завершены", card_street="Дубининская улица", events=events)
    assert checked.score == 1 and not checked.critical


def test_address_clarified_compares_card_with_reference():
    assert not address_clarified(context(""))
    assert address_clarified(context("", card_street="Дубининская улица"))
    assert not address_clarified(context("", card_street="ул. Дубнинская"))


@pytest.mark.parametrize(
    ("text", "found"),
    [
        ("Дубнинская улица, 1", None),
        ("на Дубнинской улице", None),
        ("Дубининская улица", "Дубининская"),
        ("ул. Тверская", "Тверская"),
        ("проезд затруднён, площадь пожара 20 м", None),
        ("местная бригада на месте", None),
    ],
)
def test_other_street(text, found):
    assert other_street(text, "Дубнинская улица") == found


def briefed(*briefings: dict[str, Json]):
    ctx = context("Принята, направлен экипаж 102-1.")
    ctx = EvalContext(**{**ctx.__dict__, "briefings": tuple(briefings)})
    return AddressCriterion().evaluate(ctx)


def briefing(brigade: str, address: str, heard: str | None, complete: bool = True) -> dict:
    return {
        "brigade_id": brigade,
        "at": "2026-10-16T10:00:00+00:00",
        "mode": "voice",
        "text": "",
        "address": address,
        "heard_address": heard,
        "incident": True,
        "complete": complete,
    }


def test_wrong_address_in_briefing_is_critical():
    """GP-05: бригада уехала по адресу вводной — критическая ошибка адреса."""
    checked = briefed(briefing("b1", "wrong", "Дубининская улица, 1"))
    assert checked.critical and checked.score == 0
    assert "во вводной бригаде назван адрес «Дубининская улица, 1»" in checked.explanation
    assert "Дубнинская улица, 1" in checked.explanation
    # После объединения GP-05 и TC-10 ошибка должна попасть и в структурированный разбор.
    [remark] = checked.remarks
    assert remark.kind == "error" and remark.memo_page == 32
    assert remark.quote == "Дубининская улица, 1"
    assert "Дубнинская улица, 1" in remark.consequence
    assert remark.repeat.startswith("Повторите:")


def test_only_dispatching_briefing_counts():
    """Неполная вводная бригаду не отправляла; верная первая вводная — ошибки нет."""
    assert not briefed(briefing("b1", "wrong", "Дубининская улица", complete=False)).critical
    later = briefed(briefing("b1", "ok", "Дубнинская улица, 1"), briefing("b1", "wrong", "x"))
    assert not later.critical and later.score == 1


@pytest.mark.parametrize(
    ("text", "found"),
    [
        ("Бескудниковский бульвар, д. 24, кв. 115", True),
        # Сокращение с точкой не превращает номер дома в номер квартиры/этажа.
        ("Бескудниковский бульвар, 24, кв. 115", True),
        ("Бескудниковский бульвар, 24, кв. № 115", True),
        ("Бескудниковский бульвар, 24, кв. номер 115", True),
        ("Бескудниковский бульвар, 24, эт. 9", True),
        ("Бескудниковский бульвар, 24, квартира 115", True),
        ("Бескудниковский бульвар, 24 кв.", False),
        ("Бескудниковский бульвар, 24-й эт.", False),
        ("Бескудниковский бульвар 24", True),
        ("в доме номер 24 по Бескудниковскому бульвару", True),
        ("24-й дом по Бескудниковскому бульвару", True),
        ("в 24-м доме", True),
        ("24 по Бескудниковскому бульвару", True),
        # HQ-024, круг 2: квартира, подъезд, этаж с тем же числом — не дом.
        ("Бескудниковский бульвар квартира 24 дом 7", False),
        ("Бескудниковский бульвар, кв. 24 дом 7", False),
        ("Бескудниковский бульвар, подъезд 24", False),
        ("Бескудниковский бульвар 7, этаж 24", False),
        ("Бескудниковский бульвар, квартира 24-я, дом 7", False),
        # Количественное перед «дом» — не дом: «24 дом» бывает хвостом номера квартиры.
        ("Бескудниковский бульвар, кв 115, 24 дом", False),
    ],
)
def test_house_said_only_where_house_is_named(text, found):
    """Одно правило дома для комментария, доклада, вводной и ответа бригаде (HQ-024)."""
    assert house_said(text, "24", ["Бескудниковский"]) is found
