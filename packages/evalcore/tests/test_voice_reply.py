"""DT-16: ответ бригаде голосом сводится к варианту ответа реплики бригады."""

import pytest
from evalcore.models import SpellingIssue
from evalcore.voice_reply import (
    option_address,
    reply_hints,
    spoken_numbers,
    voice_reply_option,
)

# Начальные формы слов устного ответа (в API — pymorphy3, app/core/spelling.py).
LEMMAS = {
    "понял": "понять",
    "поняли": "понять",
    "знаю": "знать",
    "ищите": "искать",
    "подъездам": "подъезд",
    "этаже": "этаж",
    "уточню": "уточнить",
    "перезвоню": "перезвонить",
    "заявителя": "заявитель",
    "заявителем": "заявитель",
    "девятом": "девятый",
    "двадцати": "двадцать",
    "двух": "два",
}


class FakeChecker:
    def check(self, text: str) -> list[SpellingIssue]:
        return []

    def lemmas(self, word: str) -> frozenset[str]:
        clean = word.casefold().replace("ё", "е")
        return frozenset({LEMMAS.get(clean, clean)})


FLOOR = [
    {"key": "floor_9", "label": "Девятый этаж"},
    {"key": "unknown", "label": "Этаж не знаю — ищите по подъездам"},
    {"key": "later", "label": "Уточню у заявителя и перезвоню"},
]
READBACK = [
    {"key": "fix", "label": "Поправка по адресу: Бескудниковский бульвар, 24"},
    {"key": "ok", "label": "Понял"},
]
DUBNA = [
    {"key": "fix", "label": "Поправка по адресу: Дубнинская улица, дом 1"},
    {"key": "ok", "label": "Понял"},
]


def option(options: list[dict], text: str) -> str | None:
    return voice_reply_option(options, text, FakeChecker())


@pytest.mark.parametrize(
    ("text", "key"),
    [
        ("Девятый этаж", "floor_9"),
        ("На девятом этаже", "floor_9"),
        ("9 этаж", "floor_9"),
        ("Девятый", "floor_9"),
        ("Квартира на 9-м этаже", "floor_9"),
        ("Этаж не знаю, ищите по подъездам", "unknown"),
        ("Не знаю, ищите по подъездам", "unknown"),
        ("Уточню и перезвоню", "later"),
        ("Сейчас уточню у заявителя", "later"),
        # Нужного числа нет — «этаж» один не решает.
        ("Восьмой этаж", None),
        ("Не знаю", None),
        ("", None),
        ("   ", None),
    ],
)
def test_floor_question(text, key):
    assert option(FLOOR, text) == key


@pytest.mark.parametrize(
    ("text", "key"),
    [
        ("Нет, Бескудниковский бульвар, двадцать четыре", "fix"),
        # GP-07: тип улицы до названия и дом словами в любом месте фразы.
        ("Бульвар Бескудниковский, дом двадцать четыре", "fix"),
        ("Двадцать четыре, Бескудниковского бульвара", "fix"),
        ("Не переулок, а бульвар! Бескудниковский бульвар 24", "fix"),
        ("Поправка: на Бескудниковском бульваре, дом 24", "fix"),
        ("Понял, выезжайте", "ok"),
        ("Понял вас", "ok"),
        # Ловушка: переулок вместо бульвара — поправкой не засчитывается.
        ("Бескудниковский переулок, 24", None),
        # Подтвердили неверный адрес — это «Понял», а не поправка.
        ("Понял, Бескудниковский переулок двадцать четыре", "ok"),
        # Без типа улицы не отличить бульвар от переулка — переспросить.
        ("Бескудниковский, 24", None),
        # Без номера дома поправка неполная.
        ("Бескудниковский бульвар", None),
        ("Бескудниковский бульвар, 26", None),
        # Номер квартиры — не дом (HQ-024, `comment.house_said`).
        ("Бескудниковский бульвар, квартира 24", None),
        ("Бескудниковский бульвар, квартира двадцать четыре, дом семь", None),
        ("Бескудниковский бульвар, двадцать четвёртый дом", "fix"),
        ("Что-то непонятное", None),
    ],
)
def test_readback_correction(text, key):
    assert option(READBACK, text) == key


@pytest.mark.parametrize(
    ("text", "key"),
    [
        ("Дубнинская улица, дом один", "fix"),
        ("На улице Дубнинской, дом 1", "fix"),
        # Ловушка: похожая, но другая улица.
        ("Дубининская улица, дом 1", None),
        ("Дубнинская улица, дом 2", None),
    ],
)
def test_street_is_compared_exactly(text, key):
    assert option(DUBNA, text) == key


def test_address_in_label():
    address = option_address("Поправка по адресу: Бескудниковский бульвар, 24")
    assert address is not None
    assert (address.name, address.street_type, address.house) == (
        ("бескудниковский",),
        "бульвар",
        "24",
    )
    address = option_address("ул. Дубнинская, д. 1")
    assert address is not None
    assert (address.street_type, address.house) == ("улица", "1")
    # Не адрес: «по адресу» без типа улицы рядом.
    assert option_address("Понял, выезжаю по адресу") is None


# Поля карточки в подписи (HQ-009): загрузчик подставил ФИО «Фамилия Имя» и телефон группами.
CARD = {"caller_name": "Тимофеев Олег Викторович", "phone_aon": "+79000000713"}
CALLER = [
    {"key": "caller", "label": "Тимофеев Олег, телефон в карточке"},
    {"key": "driver", "label": "Вызывал сам водитель"},
    {"key": "unknown", "label": "Не знаю, уточняйте на месте"},
]
PHONE = [
    {"key": "phone", "label": "Телефон заявителя: +7 900 000-07-14"},
    {"key": "later", "label": "Уточню у заявителя и перезвоню"},
]


@pytest.mark.parametrize(
    ("text", "key"),
    [
        ("Телефон в карточке", "caller"),
        ("Звонил Тимофеев Олег", "caller"),
        ("Тимофеев", "caller"),
        ("Вызывал Тимофеев Олег Викторович, номер в карточке", "caller"),
        ("Звонила Тимофеева", "caller"),
        # Чужая фамилия — не заявитель карточки.
        ("Звонил Петров Олег", None),
        ("Звонил Петров", None),
        ("Вызывал сам водитель", "driver"),
    ],
)
def test_caller_name_from_card(text, key):
    assert voice_reply_option(CALLER, text, FakeChecker(), CARD) == key


def test_caller_name_without_card_is_plain_words():
    # Без карточки ФИО — обычные слова подписи: двух из четырёх хватает.
    assert option(CALLER, "Звонил Тимофеев Олег") == "caller"
    assert option(CALLER, "Тимофеев") is None


@pytest.mark.parametrize(
    ("text", "key"),
    [
        ("+79000000714", "phone"),
        ("плюс 7 900 000-07-14", "phone"),
        ("Телефон заявителя 8 900 000 07 14", "phone"),
        ("89000000714", "phone"),
        ("семь девятьсот ноль ноль ноль ноль семь четырнадцать", "phone"),
        ("восемь девятьсот ноль ноль ноль ноль семь четырнадцать", "phone"),
        # Последних цифр хватает.
        ("Номер заканчивается на ноль семь четырнадцать", "phone"),
        ("000-07-14", "phone"),
        # Без номера — слова подписи.
        ("Телефон заявителя", "phone"),
        # Чужой номер — не засчитан, даже со словами «телефон заявителя».
        ("Телефон заявителя 8 900 000 07 15", None),
        ("+79111110715", None),
        ("Дом 24, 0714", None),
    ],
)
def test_caller_phone_by_digits(text, key):
    assert option(PHONE, text) == key


def test_tie_is_not_matched():
    options = [{"key": "a", "label": "Девятый этаж"}, {"key": "b", "label": "Девятый подъезд"}]
    assert option(options, "Девятый") is None
    assert option(options, "Девятый подъезд") == "b"


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("двадцать четыре", "24"),
        ("сто двадцать пять", "125"),
        ("на двадцати двух", "на 22"),
        ("на девятом этаже", "на 9 этаже"),
        ("пять шесть", "5 6"),
        ("двадцать одиннадцать", "20 11"),
        ("дом двадцать, четыре", "дом 20, 4"),
        ("тридцать второй", "32"),
    ],
)
def test_spoken_numbers(text, expected):
    assert spoken_numbers(text, FakeChecker()) == expected


def test_hints_are_option_labels_and_both_streets():
    scenario = {
        "card": {"address": {"street": "Бескудниковский бульвар", "house": "24"}},
        "reference": {"expected_address": {"street": "Бескудниковский бульвар", "house": "24"}},
    }
    assert reply_hints(READBACK, scenario) == (
        "Поправка по адресу: Бескудниковский бульвар, 24",
        "Понял",
        "Бескудниковский бульвар",
    )
    assert reply_hints([], {}) == ()


BUILDING = [
    {"key": "fix", "label": "Поправка по адресу: Профсоюзная улица, 98, корпус 2"},
    {"key": "ok", "label": "Понял"},
]


@pytest.mark.parametrize(
    ("options", "question", "text", "key"),
    [
        # Повтор ошибся типом улицы: поправка называет верный тип.
        (READBACK, "Как поняли? Бескудниковский переулок, 24", "Бескудниковский бульвар 24", "fix"),
        (READBACK, "Как поняли? Бескудниковский переулок, 24", "Бескудниковский 24", None),
        # Повтор ошибся домом: тип, в котором он не ошибся, можно не говорить.
        (READBACK, "Как поняли? Бескудниковский бульвар, 42", "Бескудниковский 24", "fix"),
        (READBACK, "", "Бескудниковский 24", None),
        # Повтор ошибся корпусом: поправка называет верный корпус.
        (BUILDING, "Профсоюзная улица, 98, корпус 1", "Профсоюзная 98 корпус 2", "fix"),
        (BUILDING, "Профсоюзная улица, 98, корпус 1", "Профсоюзная 98", None),
        (BUILDING, "Профсоюзная, 89, корпус 2", "Профсоюзная 98", "fix"),
        (BUILDING, "Профсоюзная, 89, корпус 2", "Профсоюзная 98 корпус 1", None),
        (BUILDING, "", "Профсоюзная 98к2", "fix"),
    ],
)
def test_correction_differs_from_readback(options, question, text, key):
    assert voice_reply_option(options, text, FakeChecker(), None, question) == key


def test_building_in_label():
    address = option_address("Поправка по адресу: Профсоюзная улица, 98, корпус 2")
    assert address is not None
    assert (address.house, address.building) == ("98", "2")
