"""Проверка орфографии без интернета и ИИ (28.09, FR-4.2): словарь OpenCorpora через
pymorphy3, словарь 112 (spelling_112.txt) и справочник улиц.

Реализует evalcore.models.TextChecker: им пользуются критерии комментария при оценке и
подсказки в АРМ (POST /spelling/check). Пропускаются: слова короче трёх букв, сокращения
из заглавных (ДТП, ГИБДД), латиница и числа, слова с заглавной буквы не в начале
предложения (имена и названия — их правильность словарь не знает; адрес проверяет свой
критерий), улицы из справочника.

Варианты исправления — слова словаря на расстоянии одной правки (пропуск, лишняя буква,
перестановка соседних, замена) и разбиение слитного написания. Дешевле всего пропущенная
буква и соседняя клавиша ЙЦУКЕН — так чаще ошибаются при быстром наборе.
"""

import re
from collections.abc import Iterable
from functools import lru_cache
from pathlib import Path
from typing import Any

import pymorphy3  # type: ignore[import-untyped]
from evalcore.models import SpellingIssue  # type: ignore[import-untyped]

WORD = re.compile(r"[А-Яа-яЁё]+(?:-[А-Яа-яЁё]+)*")
ALPHABET = "абвгдежзийклмнопрстуфхцчшщъыьэюя"
LEXICON = Path(__file__).with_name("spelling_112.txt")
SUGGESTIONS = 3
_ROWS = ("йцукенгшщзхъ", "фывапролджэ", "ячсмитьбю")
_NEIGHBOURS = {
    letter: {
        other
        for near in range(max(0, row - 1), min(len(_ROWS), row + 2))
        for other in _ROWS[near][max(0, col - 1) : col + 2]
        if other != letter
    }
    for row, keys in enumerate(_ROWS)
    for col, letter in enumerate(keys)
}
_SENTENCE_END = re.compile(r"[.!?…]\s*$")


def clean(word: str) -> str:
    return word.casefold().replace("ё", "е")


@lru_cache(maxsize=1)
def _morph() -> pymorphy3.MorphAnalyzer:
    return pymorphy3.MorphAnalyzer()


@lru_cache(maxsize=1)
def _lexicon() -> frozenset[str]:
    lines = LEXICON.read_text(encoding="utf-8").splitlines()
    return frozenset(clean(line) for line in lines if line.strip() and not line.startswith("#"))


@lru_cache(maxsize=65536)
def _normal_forms(word: str) -> frozenset[str]:
    return frozenset(clean(parse.normal_form) for parse in _morph().parse(word))


@lru_cache(maxsize=65536)
def _in_dictionary(word: str) -> bool:
    return bool(_morph().word_is_known(word))


class RussianChecker:
    """Словарь + правила пропуска; places — названия улиц и мест, считаются верными."""

    def __init__(self, places: Iterable[str] = ()) -> None:
        self.places = _place_words(places)

    def with_places(self, places: Iterable[str]) -> "RussianChecker":
        """Копия с ещё несколькими названиями (улицы сценария) — без повторного разбора."""
        copy = RussianChecker()
        copy.places = self.places | _place_words(places)
        return copy

    def lemmas(self, word: str) -> frozenset[str]:
        return _normal_forms(clean(word))

    def known(self, word: str) -> bool:
        word = clean(word)
        if _in_dictionary(word) or word in _lexicon() or word in self.places:
            return True
        forms = _normal_forms(word)
        if forms & _lexicon() or forms & self.places:
            return True
        # «северо-восточнее», «из-за»: достаточно, чтобы были верны все части.
        parts = word.split("-")
        return len(parts) > 1 and all(part and self.known(part) for part in parts)

    def check(self, text: str) -> list[SpellingIssue]:
        issues: list[SpellingIssue] = []
        for match in WORD.finditer(text):
            word = match.group()
            if self._skipped(text, match.start(), word) or self.known(word):
                continue
            issues.append(SpellingIssue(match.start(), match.end(), word, self.suggest(word)))
        return issues

    @staticmethod
    def _skipped(text: str, start: int, word: str) -> bool:
        if len(word) < 3 or sum(letter.isupper() for letter in word) >= 2:
            return True
        # Слово с заглавной не в начале предложения — имя или название.
        before = text[:start].rstrip()
        return word[0].isupper() and bool(before) and not _SENTENCE_END.search(before)

    def suggest(self, word: str) -> tuple[str, ...]:
        lower = clean(word)
        costs: dict[str, float] = {}
        for candidate, cost in _edits(lower):
            if candidate != lower and cost < costs.get(candidate, 9) and self._exact(candidate):
                costs[candidate] = cost
        # Слитное написание: «отказалсяот» → «отказался от».
        for index in range(2, len(lower) - 1):
            left, right = lower[:index], lower[index:]
            if self._exact(left) and self._exact(right) and len(right) > 1:
                costs.setdefault(f"{left} {right}", 0.7)
        ranked = sorted(
            costs,
            key=lambda item: (
                costs[item] - (0.05 if item in _normal_forms(item) else 0),
                item,
            ),
        )[:SUGGESTIONS]
        if word[:1].isupper():
            ranked = [item[:1].upper() + item[1:] for item in ranked]
        return tuple(ranked)

    def _exact(self, word: str) -> bool:
        """Слово целиком есть в словаре (без предсказания форм) — годится в исправление."""
        return _in_dictionary(word) or word in _lexicon()


def _edits(word: str) -> Iterable[tuple[str, float]]:
    for index in range(len(word) + 1):
        left, right = word[:index], word[index:]
        for letter in ALPHABET:
            yield left + letter + right, 0.5
        if right:
            yield left + right[1:], 0.6
            for letter in ALPHABET:
                if letter != right[0]:
                    near = letter in _NEIGHBOURS.get(right[0], ())
                    yield left + letter + right[1:], 0.6 if near else 1.0
        if len(right) > 1:
            yield left + right[1] + right[0] + right[2:], 0.6


def _place_words(places: Iterable[str]) -> set[str]:
    words: set[str] = set()
    for place in places:
        for word in WORD.findall(place):
            words.add(clean(word))
            words |= _normal_forms(clean(word))
    return words


@lru_cache(maxsize=4)
def checker(places: tuple[str, ...] = ()) -> RussianChecker:
    """Один проверяющий на справочник улиц: разбор названий дорогой, а справочник меняется
    редко."""
    return RussianChecker(places)


def for_scenario(streets: tuple[str, ...], card: Any, reference: Any) -> RussianChecker:
    """Справочник улиц и улицы самого сценария: справочник на стенде может быть пуст."""
    addresses = (
        card.get("address") if isinstance(card, dict) else None,
        reference.get("expected_address") if isinstance(reference, dict) else None,
    )
    extra = [str(address.get("street") or "") for address in addresses if isinstance(address, dict)]
    return checker(streets).with_places(extra)
