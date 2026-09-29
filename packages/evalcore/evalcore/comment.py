"""Критерии комментария (28.09): грамотность и ключевые сведения — без ИИ.

Q&A Q10 и FR-4.2: грамотность проверяется в момент оценки; запись должна быть понятна
следующему звену. Словарь и начальные формы даёт TextChecker из EvalContext (реализация —
в API), здесь только правила балла и пояснения.

Грамотность: балл = 1 − ошибки / max(4, слова / 5). Одна опечатка в короткой записи —
0,75; ошибка в каждом пятом слове или четыре в короткой — 0.

Ключевые сведения: те же пункты, что ищет ИИ-судья (worker/judging.py), но по словам:
адрес (улица — по начальной форме без исправления опечаток, как в критерии адреса:
«Дубнинская» ≠ «Дубининская»; дом — числом), суть происшествия (половина значимых слов
класса), решение (слова направления сил или отказа), пострадавшие (если они есть) и слова,
которые преподаватель задал в эталоне (reference.comment_keywords). Балл — доля найденных.
"""

import math
import re
from dataclasses import dataclass

from evalcore.criteria import _criterion_weight, _reference, _string_list
from evalcore.defaults import COMMENT_CRITERIA
from evalcore.models import Criterion, CriterionResult, EvalContext, Json, TextChecker

WORD = re.compile(r"[А-Яа-яЁё]+(?:-[А-Яа-яЁё]+)*")
EVIDENCE_LIMIT = 10

# Тип улицы не отличает одну улицу от другой: сравниваются только значимые слова названия.
_STREET_TYPES = frozenset(
    "улица ул проспект пр пр-т переулок пер шоссе ш бульвар б-р набережная наб площадь пл "
    "проезд пр-д тупик аллея линия микрорайон мкр квартал просек".split()
)
# Служебные части речи и слова без смысла для сути происшествия.
_STOP = frozenset(
    "с со в во на по из от до для о об при без и или а но что как к у за под над".split()
)
# Между названием улицы и номером дома: тип улицы, точка, запятая («Дубнинская ул., 1»).
_AFTER_STREET = r"(?:\s+(?:улица|ул|проспект|пр|шоссе|ш|переулок|пер))?\.?,?"
_DISPATCH = (
    "направить отправить выслать выехать выезд экипаж бригада наряд машина силы "
    "передать принять вызвать".split()
)
_REFUSAL = (
    "отказ отказать отказаться отклонить ложный ошибочный повторный дубль дублировать "
    "перенаправить переадресовать передать причина шалость неподтвердиться".split()
)
_VICTIMS = (
    "пострадавший пострадать раненый ранить ранение травма травмировать травмированный "
    "погибший погибнуть госпитализировать госпитализация потерпевший жертва ожог".split()
)


def _clean(word: str) -> str:
    return word.casefold().replace("ё", "е")


def _comment(ctx: EvalContext) -> str:
    raw = ctx.current.get("comment")
    return raw if isinstance(raw, str) else ""


def _all_comments(ctx: EvalContext) -> str:
    """Все комментарии диспетчера по карточке: каждый статус затирает текущий комментарий,
    а ключевые сведения обычно пишут при «Принята» — их нельзя терять к «Работы завершены»."""
    texts: list[str] = []
    for event in ctx.events:
        payload = event.get("payload")
        if event.get("type") in ("status_change", "redirect", "comment") and isinstance(
            payload, dict
        ):
            text = payload.get("comment")
            if isinstance(text, str) and text.strip() and text not in texts:
                texts.append(text)
    current = _comment(ctx)
    if current.strip() and current not in texts:
        texts.append(current)
    return "\n".join(texts)


def _comment_required(ctx: EvalContext) -> bool:
    return "comment" in _string_list(
        _reference(ctx).get("required_fields"), "reference.required_fields"
    )


def _checker(ctx: EvalContext) -> TextChecker:
    if ctx.text_checker is None:
        raise ValueError("Для критериев комментария нужна проверка текста (text_checker)")
    return ctx.text_checker


def _words(text: str) -> list[str]:
    return WORD.findall(text)


class SpellingCriterion:
    """Грамотность комментария: слова, которых нет в словаре, с вариантами исправления."""

    key = "spelling"

    def evaluate(self, ctx: EvalContext) -> CriterionResult:
        weight = _criterion_weight(ctx, self.key)
        comment = _comment(ctx)
        if not comment.strip():
            required = _comment_required(ctx)
            return CriterionResult(
                self.key,
                0.0 if required else 1.0,
                weight,
                False,
                ["Комментарий пуст"],
                "Комментарий не заполнен — проверять нечего."
                if required
                else "Комментарий в этом сценарии не обязателен и не заполнен.",
            )
        issues = _checker(ctx).check(comment)
        words = len(_words(comment))
        allowed = max(4.0, words / 5)
        score = max(0.0, 1 - len(issues) / allowed)
        evidence = [f"Проверено слов: {words}, ошибок: {len(issues)}"]
        for issue in issues[:EVIDENCE_LIMIT]:
            # Преподавателю — лучший вариант; все варианты видит обучаемый в подсказках АРМ.
            evidence.append(
                f"«{issue.word}» → «{issue.suggestions[0]}»"
                if issue.suggestions
                else f"«{issue.word}» — нет в словаре"
            )
        if len(issues) > EVIDENCE_LIMIT:
            evidence.append(f"И ещё ошибок: {len(issues) - EVIDENCE_LIMIT}")
        return CriterionResult(
            self.key,
            score,
            weight,
            False,
            evidence,
            "Ошибок в комментарии не найдено."
            if not issues
            else f"Ошибок в комментарии: {len(issues)}. Запись читает следующее звено — "
            "опечатки мешают её понять.",
        )


@dataclass(frozen=True)
class Fact:
    """Пункт комментария: найден, если совпало не меньше need групп слов.

    Группа — варианты (достаточно одного). exact — без исправления опечаток (улица).
    """

    label: str
    groups: tuple[tuple[str, ...], ...]
    need: int
    exact: bool = False
    house: str = ""


def _significant(text: str) -> list[str]:
    return [word for word in _words(text) if _clean(word) not in _STOP and len(word) > 1]


def comment_facts(ctx: EvalContext) -> list[Fact]:
    """Что должно быть в комментарии по карточке и эталону сценария."""
    checker = _checker(ctx)
    reference = _reference(ctx)
    card = ctx.scenario.get("card")
    card = card if isinstance(card, dict) else {}
    facts: list[Fact] = []

    address = reference.get("expected_address")
    if isinstance(address, dict):
        street = address.get("street")
        house = address.get("house")
        street_words = [
            word
            for word in _words(street if isinstance(street, str) else "")
            if _clean(word) not in _STREET_TYPES
        ]
        house_text = house.strip() if isinstance(house, str) else ""
        if street_words or house_text:
            place = ", ".join(
                part
                for part in (
                    street if isinstance(street, str) else "",
                    f"д. {house_text}" if house_text else "",
                )
                if part
            )
            facts.append(
                Fact(
                    f"Адрес: {place}",
                    tuple((word,) for word in street_words),
                    len(street_words),
                    exact=True,
                    house=house_text,
                )
            )

    incident = card.get("incident_class") or ctx.scenario.get("incident_type_code")
    if isinstance(incident, str) and incident.strip():
        # Пострадавшие — отдельный пункт: слово «пострадавших» не должно закрывать и суть
        # («ДТП с пострадавшими» без «ДТП» в комментарии — суть не названа).
        victims = {lemma for word in _VICTIMS for lemma in checker.lemmas(word)}
        words = [
            word for word in _significant(incident) if not checker.lemmas(word) & victims
        ] or _significant(incident)
        if words:
            facts.append(
                Fact(
                    f"Происшествие: {incident}",
                    tuple((word,) for word in words),
                    math.ceil(len(words) / 2),
                )
            )

    flow = reference.get("expected_flow")
    decisions = [
        state
        for state in (flow if isinstance(flow, list) else [])
        if state in ("accepted", "rejected", "redirected")
    ]
    if decisions and decisions[-1] == "accepted":
        facts.append(Fact("Решение: карточка принята, силы направлены", (tuple(_DISPATCH),), 1))
    elif decisions:
        facts.append(Fact("Причина, по которой карточка не принята", (tuple(_REFUSAL),), 1))

    if card.get("victims") is True:
        facts.append(Fact("Сведения о пострадавших", (tuple(_VICTIMS),), 1))

    extra: Json = reference.get("comment_keywords")
    for item in extra if isinstance(extra, list) else []:
        # «газ / запах газа»: варианты через косую черту, в варианте нужны все слова.
        if not isinstance(item, str) or not item.strip():
            continue
        variants = [variant.strip() for variant in item.split("/") if variant.strip()]
        facts.append(Fact(f"Ключевые слова: {item.strip()}", (tuple(variants),), 1))
    return facts


class CommentKeywordsCriterion:
    """Ключевые сведения комментария: адрес, суть, решение, пострадавшие, слова эталона."""

    key = "comment_keywords"

    def evaluate(self, ctx: EvalContext) -> CriterionResult:
        weight = _criterion_weight(ctx, self.key)
        checker = _checker(ctx)
        facts = comment_facts(ctx)
        comment = _all_comments(ctx)
        if not facts:
            return CriterionResult(
                self.key,
                1.0,
                weight,
                False,
                ["Ключевых сведений в эталоне нет"],
                "Для этого сценария ключевые сведения не заданы.",
            )
        exact, fuzzy = self._comment_lemmas(checker, comment)
        found = [fact.label for fact in facts if self._found(checker, fact, comment, exact, fuzzy)]
        missing = [fact.label for fact in facts if fact.label not in found]
        score = len(found) / len(facts)
        return CriterionResult(
            self.key,
            score,
            weight,
            False,
            [f"Есть: {'; '.join(found) or 'нет'}", f"Не хватает: {'; '.join(missing) or 'нет'}"],
            "Все ключевые сведения есть в комментарии."
            if not missing
            else "Комментарий пуст: ключевые сведения не переданы."
            if not comment.strip()
            else f"В комментарии не хватает сведений: {len(missing)} из {len(facts)}.",
        )

    @staticmethod
    def _comment_lemmas(checker: TextChecker, comment: str) -> tuple[set[str], set[str]]:
        """Начальные формы слов комментария; fuzzy — ещё и исправленных опечаток."""
        exact: set[str] = set()
        for word in _words(comment):
            exact |= checker.lemmas(word)
            exact.add(_clean(word))
        fuzzy = set(exact)
        for issue in checker.check(comment):
            for suggestion in issue.suggestions[:3]:
                fuzzy |= checker.lemmas(suggestion)
        return exact, fuzzy

    @staticmethod
    def _found(
        checker: TextChecker, fact: Fact, comment: str, exact: set[str], fuzzy: set[str]
    ) -> bool:
        pool = exact if fact.exact else fuzzy
        matched = 0
        for group in fact.groups:
            if any(_variant_found(checker, variant, pool) for variant in group):
                matched += 1
        if matched < fact.need:
            return False
        return not fact.house or _house_found(comment, fact.house, fact.groups)


def _house_found(comment: str, house: str, groups: tuple[tuple[str, ...], ...]) -> bool:
    """Номер дома после «дом», «д.» или сразу после названия улицы («Дубнинская 1»)."""
    text = _clean(comment)
    tail = rf"\.?\s*{re.escape(_clean(house))}(?![0-9а-я])"
    if re.search(rf"(?<![0-9а-я])(?:дом|д){tail}", text):
        return True
    for (word,) in (group for group in groups if len(group) == 1):
        stem = re.escape(_clean(word)[:5])
        if re.search(rf"{stem}[а-я-]*{_AFTER_STREET}{tail}", text):
            return True
    return False


def _variant_found(checker: TextChecker, variant: str, pool: set[str]) -> bool:
    """Все слова варианта есть в комментарии (по начальной форме)."""
    words = _words(variant)
    if not words:
        return False
    return all(_clean(word) in pool or bool(checker.lemmas(word) & pool) for word in words)


COMMENT_REGISTRY: dict[str, Criterion] = {
    criterion.key: criterion for criterion in (SpellingCriterion(), CommentKeywordsCriterion())
}
assert tuple(COMMENT_REGISTRY) == COMMENT_CRITERIA
