"""Должностное лицо и служба отвечают правдоподобно (TC-03): правила без ИИ и без сети.

Разговор диспетчера ДДС с дежурным службы (docs/competitors/touches.md, «Исходящий звонок
должностному лицу», п. 8, 10, 13; «Правдоподобие»):

- похожая улица Москвы (пары — `data/confusable_streets.json`, без кода) → дежурный просит
  повторить улицу по буквам (`confusable_twin`);
- дежурный называет номер регистрации или наряда (фраза банка места `registered`, поле
  `number`), его сверяют с комментарием карточки (`registration_said`);
- вопросы собеседника нейтральные: «Есть пострадавшие?», а не «Пострадавших двое?»
  (`leading_question` — словарь подсказывающих оборотов);
- время прибытия дежурный не обещает (`promises_arrival`).

Здесь только правила; данные передаёт вызывающий (API читает файл пар, тесты — data/).
"""

import re
from collections.abc import Iterable, Sequence

# Тип улицы — каноническим словом: «ул.», «пр-т», «б-р» и полное название — одна улица.
_STREET_TYPES = {
    "улица": "улица",
    "ул": "улица",
    "проспект": "проспект",
    "пр-т": "проспект",
    "пр": "проспект",
    "переулок": "переулок",
    "пер": "переулок",
    "шоссе": "шоссе",
    "ш": "шоссе",
    "бульвар": "бульвар",
    "б-р": "бульвар",
    "набережная": "набережная",
    "наб": "набережная",
    "площадь": "площадь",
    "пл": "площадь",
    "проезд": "проезд",
    "пр-д": "проезд",
    "тупик": "тупик",
    "аллея": "аллея",
}
_WORD = re.compile(r"[0-9А-Яа-яЁё]+(?:-[0-9А-Яа-яЁё]+)*")


def _clean(word: str) -> str:
    return word.casefold().replace("ё", "е")


def street_key(street: str) -> tuple[str, str | None]:
    """Название улицы без типа и тип: «ул. Дубнинская» → («дубнинская», «улица»)."""
    name: list[str] = []
    kind: str | None = None
    for word in _WORD.findall(street):
        clean = _clean(word)
        if clean in _STREET_TYPES:
            kind = _STREET_TYPES[clean]
        else:
            name.append(clean)
    return " ".join(name), kind


def _same_street(left: str, right: str) -> bool:
    """Одно название; тип сравнивается, только если он есть у обеих записей."""
    left_name, left_kind = street_key(left)
    right_name, right_kind = street_key(right)
    if not left_name or left_name != right_name:
        return False
    return left_kind is None or right_kind is None or left_kind == right_kind


def confusable_twin(street: str, pairs: Iterable[Sequence[str]]) -> str | None:
    """Улица, с которой легко спутать `street`, — как она записана в паре; нет пары — None."""
    for pair in pairs:
        if len(pair) != 2:
            continue
        first, second = pair
        if _same_street(street, first):
            return second
        if _same_street(street, second):
            return first
    return None


def registration_said(comment: str, number: str) -> bool:
    """Номер регистрации (наряда, заявки) записан в комментарии цифрами, отдельным числом.

    «Наряд 72» засчитан для номера 72, «наряд 172» и «наряд 73» — нет: чужой номер не тот.
    """
    digits = number.strip()
    if not digits.isdigit():
        return False
    return re.search(rf"(?<!\d){re.escape(digits)}(?!\d)", comment) is not None


# Подсказывающие обороты в вопросе собеседника. Вопрос — предложение, которое кончается «?».
_NUMERAL = (
    r"один|одна|одного|одну|двое|двоих|два|две|трое|троих|три|четверо|четыре|пятеро|пять|"
    r"шестеро|шесть|семь|восемь|девять|десять|\d+"
)
LEADING_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    # «Пострадавших двое?» — число в вопросе называет ответ за диспетчера.
    ("число в вопросе", re.compile(rf"(?<![а-яё])(?:{_NUMERAL})(?![а-яё])", re.I)),
    # «Пострадавших нет, да?» — хвост-подтверждение после запятой или тире.
    (
        "вопрос-подтверждение",
        re.compile(
            r"[,—–-]\s*(?:да|нет|верно|правильно|так|ведь|не так ли|не правда ли)\s*\?$", re.I
        ),
    ),
    # «Наверное, газ?», «Ведь никто не пострадал?» — догадка вместо вопроса.
    (
        "догадка в вопросе",
        re.compile(
            r"(?<![а-яё])(?:наверное|наверно|скорее всего|видимо|ведь|надеюсь|случайно не|"
            r"неужели|разве)(?![а-яё])",
            re.I,
        ),
    ),
)

_QUESTION = re.compile(r"[^.?!…]*\?")


def leading_question(text: str) -> str | None:
    """Что в реплике подсказывает ответ: название оборота и вопрос; нейтральная — None."""
    for question in _QUESTION.findall(text):
        sentence = question.strip()
        for label, pattern in LEADING_PATTERNS:
            if pattern.search(sentence):
                return f"{label}: «{sentence}»"
    return None


# Время прибытия дежурный не обещает (touches.md, п. 10): «будут через пять минут»,
# «в ближайшее время», «скоро будут».
_ARRIVAL = re.compile(
    r"(?<![а-яё])(?:через\s+\S+\s+минут\w*|минут\w*\s+через|в\s+ближайшее\s+время|скоро\s+будут|"
    r"будут\s+через|будем\s+через|прибуд\w+\s+через)(?![а-яё])",
    re.I,
)


def promises_arrival(text: str) -> bool:
    """Реплика обещает время прибытия сил."""
    return _ARRIVAL.search(text) is not None
