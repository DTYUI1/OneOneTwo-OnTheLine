"""GP-05: вводная бригаде — адрес, который поняла бригада, и повод."""

import json
from pathlib import Path

import pytest
from evalcore.briefing import ADDRESS_MISSING, ADDRESS_OK, ADDRESS_WRONG, briefing_check

from .test_report import FakeChecker

SCENARIO_FILE = Path(__file__).parents[3] / "data" / "scenarios" / "smoke-apartment-101-1.json"
# Карточка: «задымление: квартира», Бескудниковский бульвар, дом 24, квартира 115.
SCENARIO = json.loads(SCENARIO_FILE.read_text(encoding="utf-8"))


def check(text: str):
    return briefing_check(SCENARIO, text, FakeChecker())


@pytest.mark.parametrize(
    "text",
    [
        "Бескудниковский бульвар, дом 24, квартира 115. Задымление в квартире.",
        "Бескудниковский бульвар, двадцать четыре, задымление в квартире",
        # По частям: адрес карточки и повод склеены в одну фразу.
        "Бескудниковский бульвар, дом 24, квартира 115. задымление: квартира",
        # Повод пересказом описания карточки.
        "Выезжайте на Бескудниковский бульвар 24, из-под двери квартиры идёт дым",
    ],
)
def test_full_briefing_with_card_address(text: str) -> None:
    result = check(text)
    assert result.address == ADDRESS_OK
    assert result.heard_address == "Бескудниковский бульвар, 24"
    assert result.incident
    assert result.complete


@pytest.mark.parametrize(
    ("text", "heard"),
    [
        # Тот же корень, другой тип — другая улица в Москве.
        ("Бескудниковский переулок, 24, задымление в квартире", "Бескудниковский переулок, 24"),
        ("Улица Дубнинская, дом 12, задымление в квартире", "улица Дубнинская, 12"),
        # Та же улица, другой дом.
        ("Бескудниковский бульвар, 42, задымление в квартире", "Бескудниковский бульвар, 42"),
    ],
)
def test_wrong_address_is_what_brigade_heard(text: str, heard: str) -> None:
    result = check(text)
    assert result.address == ADDRESS_WRONG
    assert result.heard_address == heard
    assert result.complete


@pytest.mark.parametrize(
    "text",
    [
        "Задымление в квартире, выезжайте",
        "Бескудниковский бульвар, задымление в квартире",
        "",
    ],
)
def test_without_address_or_house_brigade_asks_again(text: str) -> None:
    result = check(text)
    assert result.address == ADDRESS_MISSING
    assert result.heard_address is None
    assert not result.complete


def test_without_incident_briefing_is_not_complete() -> None:
    result = check("Бескудниковский бульвар, дом 24")
    assert result.address == ADDRESS_OK
    assert not result.incident
    assert not result.complete
