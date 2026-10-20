"""Текст реплики → текст для синтеза (TC-09): синтезатор читает только слова.

    from sayable import Pronunciation
    spoken = Pronunciation.load(path).say("Экипаж ДПС, дом 24А, телефон 8 (495) 123-45-07")

- телефоны (от семи цифр) — группами, как записаны, ведущие нули — «ноль»;
- номера домов, квартир, нарядов и прочие числа — числительными: «24А» → «двадцать четыре а»,
  «24/1» → «двадцать четыре дробь один»;
- аббревиатуры прописными (МЧС, ДДС, ДТП) — по буквам, ударение на последний слог;
- словарь ударений data/pronunciation.json: слово → форма с «+» перед ударной гласной (так
  ударение понимает Vosk TTS). Там же исключения: аббревиатуры, которые читаются словом.

Ревизия словаря входит в ключ кеша озвучки (scenario_synth.py): правка словаря — новая
ревизия, и реплики с затронутыми словами перерендерятся.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

UNITS = ["ноль", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"]
TEENS = [
    "десять",
    "одиннадцать",
    "двенадцать",
    "тринадцать",
    "четырнадцать",
    "пятнадцать",
    "шестнадцать",
    "семнадцать",
    "восемнадцать",
    "девятнадцать",
]
TENS = [
    "",
    "",
    "двадцать",
    "тридцать",
    "сорок",
    "пятьдесят",
    "шестьдесят",
    "семьдесят",
    "восемьдесят",
    "девяносто",
]
HUNDREDS = [
    "",
    "сто",
    "двести",
    "триста",
    "четыреста",
    "пятьсот",
    "шестьсот",
    "семьсот",
    "восемьсот",
    "девятьсот",
]
# Названия букв для чтения аббревиатур; ударение ставится на последнюю букву.
LETTERS = {
    "А": "а",
    "Б": "бэ",
    "В": "вэ",
    "Г": "гэ",
    "Д": "дэ",
    "Е": "е",
    "Ё": "ё",
    "Ж": "жэ",
    "З": "зэ",
    "И": "и",
    "Й": "й",
    "К": "ка",
    "Л": "эл",
    "М": "эм",
    "Н": "эн",
    "О": "о",
    "П": "пэ",
    "Р": "эр",
    "С": "эс",
    "Т": "тэ",
    "У": "у",
    "Ф": "эф",
    "Х": "ха",
    "Ц": "цэ",
    "Ч": "че",
    "Ш": "ша",
    "Щ": "ща",
    "Ы": "ы",
    "Э": "э",
    "Ю": "ю",
    "Я": "я",
}
VOWELS = "аеёиоуыэюя"

PHONE = re.compile(r"(?<![\d/])\+?\d[\d \-()]{5,}\d(?![\d/])")
NUMBER = re.compile(r"(?<![\w+])(\d+)(?:([А-Яа-яЁё])(?![А-Яа-яЁё]))?(?:/(\d+))?")
ABBREVIATION = re.compile(r"\b[А-ЯЁ]{2,6}\b")
WORD = re.compile(r"[А-Яа-яЁё]+")


def number(value: int) -> str:
    """Количественное числительное, именительный падеж, до 999 999."""
    if value < 10:
        return UNITS[value]
    if value >= 1000:
        thousands, rest = divmod(value, 1000)
        head = number(thousands)
        head = re.sub(r"один$", "одна", re.sub(r"два$", "две", head))
        last, last_two = thousands % 10, thousands % 100
        if last == 1 and last_two != 11:
            word = "тысяча"
        elif 2 <= last <= 4 and not 12 <= last_two <= 14:
            word = "тысячи"
        else:
            word = "тысяч"
        head_words = [] if thousands == 1 else [head]
        return " ".join(head_words + [word] + ([number(rest)] if rest else []))
    hundreds, rest = divmod(value, 100)
    parts = [HUNDREDS[hundreds]] if hundreds else []
    if 10 <= rest <= 19:
        parts.append(TEENS[rest - 10])
    else:
        tens, units = divmod(rest, 10)
        if tens:
            parts.append(TENS[tens])
        if units:
            parts.append(UNITS[units])
    return " ".join(parts)


def digits(group: str) -> str:
    """Группа цифр телефона: ведущие нули — «ноль», остаток — числом («05» → «ноль пять»)."""
    zeros = len(group) - len(group.lstrip("0"))
    rest = group[zeros:]
    return " ".join(["ноль"] * zeros + ([number(int(rest))] if rest else []))


def phone_groups(raw: str) -> list[str]:
    """Группы телефона как записаны; слитный номер — по-московски 3-3-2-2."""
    groups = re.findall(r"\d+", raw)
    if len(groups) == 1 and len(groups[0]) in (7, 10, 11):
        run = groups[0]
        head = [run[0]] if len(run) == 11 else []
        tail = run[1:] if len(run) == 11 else run
        sizes = [3, 3, 2, 2] if len(tail) == 10 else [3, 2, 2]
        groups, at = head, 0
        for size in sizes:
            groups.append(tail[at : at + size])
            at += size
    return groups


def spell(abbreviation: str) -> str:
    """«ДТП» → «дэтэп+э»: названия букв одним словом, ударение на последней гласной."""
    word = "".join(LETTERS[letter] for letter in abbreviation)
    for at in range(len(word) - 1, -1, -1):
        if word[at] in VOWELS:
            return word[:at] + "+" + word[at:]
    return word


@dataclass
class Pronunciation:
    revision: int = 0
    stress: dict[str, str] = field(default_factory=dict)
    as_word: frozenset[str] = frozenset()

    @classmethod
    def load(cls, path: Path) -> Pronunciation:
        data = json.loads(path.read_text(encoding="utf-8"))
        return cls(
            revision=int(data["revision"]),
            stress={key.lower(): value for key, value in data["stress"].items()},
            as_word=frozenset(data.get("as_word", [])),
        )

    def say(self, text: str) -> str:
        def phone(match: re.Match[str]) -> str:
            raw = match.group(0)
            if sum(char.isdigit() for char in raw) < 7:
                return raw
            spoken = [digits(group) for group in phone_groups(raw)]
            return ("плюс " if raw.startswith("+") else "") + ", ".join(spoken)

        def numeral(match: re.Match[str]) -> str:
            whole, letter, fraction = match.groups()
            parts = [
                digits(whole) if whole.startswith("0") and whole != "0" else number(int(whole))
            ]
            if letter:
                parts.append(LETTERS[letter.upper()])
            if fraction:
                parts += ["дробь", number(int(fraction))]
            return " ".join(parts)

        def abbreviation(match: re.Match[str]) -> str:
            word = match.group(0)
            if word in self.as_word or word.lower() in self.stress:
                return word
            return spell(word)

        def stressed(match: re.Match[str]) -> str:
            word = match.group(0)
            form = self.stress.get(word.lower())
            if form is None:
                return word
            return form[0].upper() + form[1:] if word[0].isupper() else form

        text = PHONE.sub(phone, text)
        text = NUMBER.sub(numeral, text)
        text = ABBREVIATION.sub(abbreviation, text)
        text = WORD.sub(stressed, text)
        return re.sub(r"\s+", " ", text).strip()
