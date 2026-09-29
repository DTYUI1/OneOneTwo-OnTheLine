"""Адрес в комментарии (карточки без ручного адреса): обычная запись засчитывается,
похожая другая улица — нет (29.09, по ручной проверке тренировки)."""

import json
from pathlib import Path

import pytest
from evalcore.criteria import AddressCriterion
from evalcore.models import EvalContext

GOLDEN = Path(__file__).parents[3] / "data" / "golden_scenarios" / "case-01.json"


def result(comment: str):
    fixture = json.loads(GOLDEN.read_text(encoding="utf-8"))
    ctx = EvalContext(
        scenario=fixture["scenario"],
        current={"service_number": "1", "comment": comment},
        events=[],
        calls=[],
        settings=fixture["settings"],
    )
    return AddressCriterion().evaluate(ctx)


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
    checked = result(comment)
    assert checked.score == 1 and not checked.critical, checked.explanation


def test_similar_street_and_stray_number_are_not_accepted():
    other_street = result("Москва, Дубининская улица, 1")
    assert other_street.critical and "улица" in other_street.explanation
    stray = result("Москва, Дубнинская улица, пострадавших 1")
    assert stray.critical and "дом" in stray.explanation
    wrong_house = result("Москва, Дубнинская улица, 12")
    assert wrong_house.critical
