"""Понятный, но ошибочный повод не равен отсутствию вводной."""

import json
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import pytest
from evalcore.briefing import ADDRESS_OK, briefing_check
from evalcore.models import TextChecker

from .test_report import FakeChecker

SCENARIO = json.loads(
    (Path(__file__).parents[3] / "data/scenarios/gas-apartment-101-1.json").read_text(
        encoding="utf-8"
    )
)


@pytest.fixture(params=("fake", "production"))
def incident_checker(request: pytest.FixtureRequest) -> TextChecker:
    if request.param == "fake":
        return FakeChecker()
    # Реальный потребитель внедряется только в тесте; evalcore не импортирует приложение.
    pytest.importorskip("pymorphy3")
    source = Path(__file__).parents[3] / "apps/api/app/core/spelling.py"
    spec = spec_from_file_location("briefing_production_spelling", source)
    assert spec is not None and spec.loader is not None
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.RussianChecker()


@pytest.mark.parametrize(
    ("scenario_id", "incident"),
    (
        ("gas-apartment-101-1", "Запах газа не уходит"),
        ("lift-child-moslift-1", "Застревание в лифте (ребенок без взрослых)"),
        ("lift-fault-moslift-2", "Не закрываются двери лифта"),
    ),
)
def test_catalog_negative_conditions_remain_complete(
    scenario_id: str, incident: str, incident_checker: TextChecker
) -> None:
    scenario = json.loads(
        (Path(__file__).parents[3] / f"data/scenarios/{scenario_id}.json").read_text(
            encoding="utf-8"
        )
    )
    address = scenario["card"]["address"]
    result = briefing_check(
        scenario, f"{address['street']}, {address['house']}. {incident}", incident_checker
    )
    assert result.incident
    assert result.incident_said
    assert result.complete


@pytest.mark.parametrize("incident", ("Человек не дышит", "Лифт не работает"))
def test_negative_condition_is_a_meaningful_wrong_incident(
    incident: str, incident_checker: TextChecker
) -> None:
    result = briefing_check(SCENARIO, f"улица Плеханова, 11. {incident}", incident_checker)
    assert not result.incident
    assert result.incident_said
    assert result.complete


@pytest.mark.parametrize(
    ("incident", "complete"),
    (
        ("Пожара нет", False),
        ("Драки нет", False),
        ("Не знаю, что случилось", False),
        ("нет газа", False),
        ("ДТП без пострадавших", True),
        ("Пахнет газом, не выезжайте", True),
    ),
)
def test_event_negation_boundary_with_real_checker(
    incident: str, complete: bool, incident_checker: TextChecker
) -> None:
    result = briefing_check(SCENARIO, f"улица Плеханова, 11. {incident}", incident_checker)
    assert result.incident_said is complete
    assert result.complete is complete


@pytest.mark.parametrize("text", ("Пожара здесь не было", "Не чувствуется запах газа"))
def test_scoped_event_negation_is_not_an_assertion(
    text: str, incident_checker: TextChecker
) -> None:
    result = briefing_check(SCENARIO, f"улица Плеханова, 11. {text}", incident_checker)
    assert result.address == ADDRESS_OK
    assert not result.incident
    assert not result.incident_said
    assert not result.complete


@pytest.mark.parametrize(
    "text",
    (
        "Запах газа. Поправка: запаха газа нет",
        "Запах газа. Поправка: пожар. Поправка: пожара нет",
    ),
)
def test_explicit_cancellation_clears_accumulated_incident(
    text: str, incident_checker: TextChecker
) -> None:
    result = briefing_check(SCENARIO, f"улица Плеханова, 11. {text}", incident_checker)
    assert result.address == ADDRESS_OK
    assert result.heard_address == "улица Плеханова, 11"
    assert not result.incident
    assert not result.incident_said
    assert not result.complete


@pytest.mark.parametrize(
    "text",
    (
        "Запах газа исправляю пожар в подъезде",
        "Запах газа нет исправляю пожар в подъезде",
        "Запах газа исправляю пожар в подъезде исправляю драка на улице",
    ),
)
def test_unpunctuated_correction_replaces_incident(
    text: str, incident_checker: TextChecker
) -> None:
    result = briefing_check(SCENARIO, f"улица Плеханова, 11. {text}", incident_checker)
    assert result.address == ADDRESS_OK
    assert not result.incident
    assert result.incident_said
    assert result.complete


@pytest.mark.parametrize("text", ("Вы сказали пожар?", "Какой, пожар?", "Какой пожар?"))
def test_metareport_question_does_not_assert_incident(
    text: str, incident_checker: TextChecker
) -> None:
    result = briefing_check(SCENARIO, f"улица Плеханова, 11. {text}", incident_checker)
    assert result.address == ADDRESS_OK
    assert not result.incident
    assert not result.incident_said
    assert not result.complete


@pytest.mark.parametrize("text", ("Запах газа. Вы сказали пожар?", "Запах газа, вы меня слышите?"))
def test_question_scope_does_not_erase_separate_assertion(
    text: str, incident_checker: TextChecker
) -> None:
    result = briefing_check(SCENARIO, f"улица Плеханова, 11. {text}", incident_checker)
    assert result.address == ADDRESS_OK
    assert result.incident
    assert result.incident_said
    assert result.complete


def test_wrong_incident_is_heard_and_dispatches_brigade() -> None:
    result = briefing_check(SCENARIO, "улица Плеханова, 11. Драка на улице", FakeChecker())

    assert result.address == ADDRESS_OK
    assert result.heard_address == "улица Плеханова, 11"
    assert result.complete, "Понятный ошибочный повод нельзя превращать в отсутствие повода"
    assert result.incident_said
    assert not result.incident


# Все действительные ложные варианты OTHER_INCIDENTS в parts.ts и голосовые аналоги.
MEANINGFUL = (
    "Пожар в подъезде",
    "Запах газа в подъезде",
    "Драка на улице",
    "Человеку плохо на улице",
    "Затопление квартиры",
    "Застрял лифт",
    "ДТП без пострадавших",
    "горит квартира",
    "из окна идет дым",
    "пахнет газом",
    "на улице дерутся люди",
    "мужчина потерял сознание",
    "прорвало трубу, квартиру заливает",
    "люди застряли в лифте",
    "столкнулись две машины",
)


@pytest.mark.parametrize("incident", MEANINGFUL)
def test_meaningful_incident_is_heard(incident: str) -> None:
    result = briefing_check(SCENARIO, f"улица Плеханова, 11. {incident}", FakeChecker())
    assert result.incident_said
    assert result.complete


@pytest.mark.parametrize(
    "text",
    (
        "",
        "улица Плеханова, 11",
        "ээээ шшш",
        "спасибо, до свидания",
        "Повторите, пожалуйста, я вас не слышу",
        "Выезжайте, адрес понятен?",
        "Как выбрать происшествие?",
        "Драки нет",
        "Это не драка",
        "Пожара не было",
        "Не горит",
        "Запаха газа нет",
        "Человеку не плохо",
        "Лифт не застрял",
        "ДТП не было",
        "Квартиру не заливает",
        "Пожара нет, улица Плеханова, 11",
        "Драки нет. Адрес улица Плеханова, 11",
        "Без пожара",
        "Без утечки газа",
    ),
)
def test_no_affirmative_incident_is_not_heard(text: str) -> None:
    result = briefing_check(SCENARIO, text, FakeChecker())
    assert not result.incident_said
    assert not result.incident
    assert not result.complete


@pytest.mark.parametrize(
    ("text", "correct"),
    (
        ("Запах бытового газа в квартире. Нет, это драка на улице", False),
        ("Запах бытового газа в квартире. Поправка: пожар в подъезде", False),
        ("Драка на улице. Нет, запах бытового газа в квартире", True),
        ("Не драка, а запах бытового газа в квартире", True),
        ("Запах бытового газа в квартире. Пожар в подъезде", False),
        ("Запах бытового газа в квартире. Не отключайте связь", True),
    ),
)
def test_last_incident_wins_without_erasing_address(text: str, correct: bool) -> None:
    result = briefing_check(SCENARIO, f"улица Плеханова, 11. {text}", FakeChecker())
    assert result.incident is correct
    assert result.incident_said
    assert result.address == ADDRESS_OK
    assert result.complete


@pytest.mark.parametrize(
    "text",
    (
        "Какой пожар выбрать?",
        "Повторите слово драка",
        "Пожалуйста, скажите ДТП",
        "Мы обсуждаем слово газ",
        "Спасибо пожарным",
        "Пожарные, вы меня слышите?",
    ),
)
def test_meta_speech_is_not_an_incident(text: str) -> None:
    assert not briefing_check(SCENARIO, text, FakeChecker()).incident_said


@pytest.mark.parametrize("street", ("улица Драки", "улица Пожарная", "Дымный переулок"))
def test_event_word_in_street_is_not_an_incident(street: str) -> None:
    from copy import deepcopy

    scenario = deepcopy(SCENARIO)
    scenario["reference"]["expected_address"] = {"street": street, "house": "11"}
    result = briefing_check(scenario, f"{street}, 11", FakeChecker())
    assert result.address == ADDRESS_OK
    assert not result.incident_said
    assert not result.complete
