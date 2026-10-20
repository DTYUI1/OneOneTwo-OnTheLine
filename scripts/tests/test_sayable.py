"""Текст для синтеза (TC-09): номера, телефоны, аббревиатуры и словарь ударений."""

import json
from pathlib import Path

import pytest

from scripts.voices.sayable import Pronunciation, number

ROOT = Path(__file__).resolve().parents[2]
DICTIONARY = ROOT / "data" / "pronunciation.json"


@pytest.fixture
def say():
    return Pronunciation.load(DICTIONARY).say


@pytest.mark.parametrize(
    ("value", "words"),
    [
        (0, "ноль"),
        (7, "семь"),
        (12, "двенадцать"),
        (40, "сорок"),
        (115, "сто пятнадцать"),
        (512, "пятьсот двенадцать"),
        (1001, "тысяча один"),
        (2024, "две тысячи двадцать четыре"),
        (21000, "двадцать одна тысяча"),
        (14500, "четырнадцать тысяч пятьсот"),
    ],
)
def test_number_words(value, words):
    assert number(value) == words


def test_house_and_crew_numbers(say):
    assert say("Бескудниковский бульвар, дом 24, квартира 115.") == (
        "Бескудниковский бульвар, дом двадцать четыре, квартира сто пятнадцать."
    )
    assert say("Дом 24А, корпус 3, строение 7/2.") == (
        "Дом двадцать четыре а, корпус три, строение семь дробь два."
    )
    assert say("Наряд 512 на месте.") == "Наряд пятьсот двенадцать на месте."


def test_phone_numbers_in_groups(say):
    assert say("Телефон 8 (495) 123-45-07.") == (
        "Телефон восемь, четыреста девяносто пять, сто двадцать три, сорок пять, ноль семь."
    )
    assert say("+7 916 005-00-12") == (
        "плюс семь, девятьсот шестнадцать, ноль ноль пять, ноль ноль, двенадцать"
    )
    assert say("84951234567") == (
        "восемь, четыреста девяносто пять, сто двадцать три, сорок пять, шестьдесят семь"
    )
    # Короткие номера служб — обычным числом, это не телефон из семи цифр.
    assert say("Звоните 112.") == "Звоните сто двенадцать."


def test_abbreviations_by_letters(say):
    assert say("Экипаж ДПС направлен, оформляем ДТП.") == (
        "Экипаж дэпэ+эс направлен, оформляем дэтэп+э."
    )
    assert say("МЧС и ДДС района") == "эмче+эс и дэдэ+эс района"
    assert say("Аварийная МОСГАЗ") == "Аварийная МОСГАЗ"


def test_stress_dictionary(say):
    assert say("Перелом бедра, механик уже вывел.") == "Перелом бедр+а, механик уж+е вывел."
    assert say("Уже на месте.") == "Уж+е на месте."


def test_dictionary_revision_and_forms():
    data = json.loads(DICTIONARY.read_text(encoding="utf-8"))
    assert isinstance(data["revision"], int) and data["revision"] >= 1
    for word, form in data["stress"].items():
        assert form.replace("+", "") == word and form.count("+") == 1, word
