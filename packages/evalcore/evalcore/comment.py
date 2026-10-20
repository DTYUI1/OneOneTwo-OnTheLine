"""Критерии комментария (28.09): грамотность и ключевые сведения — без ИИ.

Q&A Q10 и FR-4.2: грамотность проверяется в момент оценки; запись должна быть понятна
следующему звену. Словарь и начальные формы даёт TextChecker из EvalContext (реализация —
в API), здесь только правила балла и пояснения.

Грамотность: балл = 1 − ошибки / max(4, слова / 5). Одна опечатка в короткой записи —
0,75; ошибка в каждом пятом слове или четыре в короткой — 0.

Ключевые сведения: те же пункты, что ищет ИИ-судья (worker/judging.py), но по словам:
уточнённый адрес, если эталон отличается от адреса карточки (DT-14; улица — по начальной
форме без исправления опечаток, как в критерии адреса: «Дубнинская» ≠ «Дубининская»;
дом — числом), суть происшествия (половина значимых слов
класса или повод своими словами — то же правило, что в докладе службе, `report.reason_said`:
«столкнулись», «зажат»), решение (слова направления сил или отказа), пострадавшие (если они
есть: «пострадавший» или состояние человека — «зажат», «в сознании», «боль») и слова,
которые преподаватель задал в эталоне (reference.comment_keywords) и номер регистрации, который
назвало должностное лицо службы в звонке (TC-03, `call_hangup.registration_number`): засчитан
только этот номер отдельным числом, чужой — нет. Балл — доля найденных.

Суть и пострадавшие засчитываются и словами самой карточки (TC-10): комментарий повторяет
не меньше половины значимых слов описания (`card.description`). Класс происшествия —
слово классификатора («Беспорядки - драка на улице»), а диспетчер пишет, что видит
карточка («дерутся четверо мужчин, у одного разбита голова»): без этого эталонное
прохождение получало ложное «не хватает сути» (тест apps/api/tests/test_reference_runs.py).
Выяснено или угадано (HQ-020): сведение из разговора засчитывается, только если оно прозвучало
для обучаемого до записи комментария. Источник определяется сам: пункт есть в тексте карточки
(`scenario.card`) или это решение самого диспетчера — источник карточка, засчитывается всегда;
иначе пункт ищется в репликах собеседников (`EvalContext.lines`: предъявленных и докладах плана —
реплика несработавшей ветки или события источником не делает) и в докладе, который добавил его
перемене задачи (`task_change.comment_keywords`); номер регистрации прозвучал при ответе на звонок.
Пункт из разговора засчитан, если найден в комментариях, сохранённых не раньше первого
предъявления такой реплики (`server_ts` статуса ≥ `presented_at`; текущий комментарий карточки
без события — в конце). Нигде не найден — это знание самого диспетчера («112»), засчитывается как
раньше. Балл: найдено и прозвучало / всего пунктов.
"""

import math
import re
from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import datetime

from evalcore import remarks
from evalcore.criteria import (
    _all_comments,
    _call_key,
    _criterion_weight,
    _reference,
    _string_list,
    address_clarified,
)
from evalcore.defaults import _CASE_TYPE_MIN, COMMENT_CRITERIA
from evalcore.models import (
    Criterion,
    CriterionResult,
    EvalContext,
    Json,
    Remark,
    SpellingIssue,
    TextChecker,
)
from evalcore.officials import registration_said
from evalcore.task_change import _time

WORD = re.compile(r"[А-Яа-яЁё]+(?:-[А-Яа-яЁё]+)*")
NUMBER = re.compile(r"\d+")
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
# Между названием улицы и номером дома: тип улицы, точка, запятая («Дубнинская ул., 1»,
# «Бескудниковский бульвар 24»). Типы — все из _STREET_TYPES: без «бульвара» дом после
# названия не находился, и доклад «Бескудниковский бульвар 24» не засчитывал адрес (12.10).
_AFTER_STREET = (
    r"(?:\s+(?:"
    + "|".join(
        # В падежах: «Бескудниковского бульвара 24», «Дубнинской улицы 1».
        re.escape(kind[:-1]) + "[а-я]*" if len(kind) >= _CASE_TYPE_MIN else re.escape(kind)
        for kind in sorted(_STREET_TYPES, key=len, reverse=True)
    )
    + r"))?\.?,?"
)
# Тип улицы перед названием: «24, бульвар Бескудниковский».
_BEFORE_STREET = (
    r"(?:(?:"
    + "|".join(
        re.escape(kind[:-1]) + "[а-я]*" if len(kind) >= _CASE_TYPE_MIN else re.escape(kind)
        for kind in sorted(_STREET_TYPES, key=len, reverse=True)
    )
    + r")\.?\s+)?"
)
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
# Состояние человека словами описания карточки: «зажат водитель, в сознании», «жалуется на
# боль в шее», «разбита голова». Это сведения о пострадавших, хотя слова «пострадавший» нет
# (разбор карточки 18.10: описание, переписанное в комментарий, давало «не хватает»).
_VICTIM_SIGNS = (
    "боль",
    "болеть",
    "жаловаться",
    "сознание",
    "кровь",
    "кровотечение",
    "перелом",
    "ушиб",
    "зажать",
    "зажатый",
    "разбить голова",
    "разбитый голова",
)


def _clean(word: str) -> str:
    return word.casefold().replace("ё", "е")


def _comment(ctx: EvalContext) -> str:
    raw = ctx.current.get("comment")
    return raw if isinstance(raw, str) else ""


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


def _numbers(text: str) -> list[str]:
    """Числа текста целиком: «112», «в 112-ю» → «112»; «1123» — не «112»."""
    return NUMBER.findall(text)


class SpellingCriterion:
    """Грамотность комментария: слова, которых нет в словаре, с вариантами исправления."""

    key = "spelling"

    def evaluate(self, ctx: EvalContext) -> CriterionResult:
        weight = _criterion_weight(ctx, self.key)
        comment = _comment(ctx)
        if not _words(comment):
            return CriterionResult(
                self.key,
                0.0,
                0.0,
                False,
                ["В комментарии нет слов для проверки"],
                "Грамотность не оценивается: комментарий пуст или не содержит слов.",
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
            (_spelling_remark(comment, issues),) if issues and score < 1 else (),
        )


def _spelling_remark(comment: str, issues: list[SpellingIssue]) -> Remark:
    """Опечатки — первые две с исправлением; цитата — вокруг первой."""
    first = issues[0]
    examples = "; ".join(
        f"«{issue.word}» → «{issue.suggestions[0]}»" if issue.suggestions else f"«{issue.word}»"
        for issue in issues[:2]
    )
    return remarks.spelling(
        examples,
        first.word,
        first.suggestions[0] if first.suggestions else None,
        remarks.quote_span(comment, first.start, first.end),
    )


@dataclass(frozen=True)
class Fact:
    """Пункт комментария: найден, если совпало не меньше need групп слов.

    Группа — варианты (достаточно одного). exact — без исправления опечаток (улица).
    card_words — слова описания карточки: пункт найден и тогда, когда комментарий повторяет
    не меньше половины из них (суть и пострадавшие словами карточки, TC-10).
    kind — вид пункта для замечания разбора: address, incident, decision, refusal, victims,
    keywords (evalcore/remarks.py).
    number — номер регистрации цифрами: найден, только если записан отдельным числом.
    building — корпус дома: сверяется, если назван (`house_said`).
    conversation — сведение узнают только из разговора (HQ-020): засчитывается в комментариях,
    сохранённых с `heard_at`; `heard_at` None — в разговоре не прозвучало.
    """

    label: str
    groups: tuple[tuple[str, ...], ...]
    need: int
    exact: bool = False
    house: str = ""
    kind: str = "keywords"
    card_words: tuple[str, ...] = ()
    number: str = ""
    building: str = ""
    conversation: bool = False
    heard_at: datetime | None = None
    # Суть происшествия: найдена и по правилу повода (`report.reason_said`) — синонимы
    # класса («столкнулись» — ДТП, «зажат» — заблокированные) или пересказ описания.
    reason: bool = False


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
    # DT-14 (08.10): верный адрес карточки диспетчер ДДС в комментарии может не повторять;
    # ключевое сведение — только уточнённый адрес. Искажённый адрес ловит критерий «Адрес».
    if isinstance(address, dict) and address_clarified(ctx):
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
            fact = Fact(
                f"Адрес: {place}",
                tuple((word,) for word in street_words),
                len(street_words),
                exact=True,
                house=house_text,
                kind="address",
            )
            # Уточнённый адрес обычно докладывает бригада: без доклада он угадан.
            facts.append(_sourced(ctx, checker, fact))

    description = card.get("description")
    described = tuple(_significant(description)) if isinstance(description, str) else ()
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
                    kind="incident",
                    card_words=described,
                    reason=True,
                )
            )

    flow = reference.get("expected_flow")
    decisions = [
        state
        for state in (flow if isinstance(flow, list) else [])
        if state in ("accepted", "rejected", "redirected")
    ]
    if decisions and decisions[-1] == "accepted":
        facts.append(
            Fact(
                "Решение: карточка принята, силы направлены",
                (tuple(_DISPATCH),),
                1,
                kind="decision",
            )
        )
    elif decisions:
        facts.append(
            Fact("Причина, по которой карточка не принята", (tuple(_REFUSAL),), 1, kind="refusal")
        )

    if card.get("victims") is True:
        facts.append(
            Fact(
                "Сведения о пострадавших",
                ((*_VICTIMS, *_VICTIM_SIGNS),),
                1,
                kind="victims",
                card_words=described,
            )
        )

    extra: Json = reference.get("comment_keywords")
    reported = _task_change_keywords(ctx)
    for item in extra if isinstance(extra, list) else []:
        # «газ / запах газа»: варианты через косую черту, в варианте нужны все слова.
        if not isinstance(item, str) or not item.strip():
            continue
        variants = [variant.strip() for variant in item.split("/") if variant.strip()]
        fact = Fact(f"Ключевые слова: {item.strip()}", (tuple(variants),), 1)
        facts.append(_sourced(ctx, checker, fact, reported.get(item.strip(), [])))

    answered = _answered_at(ctx)
    for phone_ext, number in registrations(ctx):
        heard_at = answered.get(number)
        # Номер называет дежурный в звонке: записать его можно только после ответа на звонок.
        facts.append(
            Fact(
                f"Номер регистрации службы {phone_ext}: {number}",
                (),
                0,
                number=number,
                conversation=heard_at is not None,
                heard_at=heard_at,
            )
        )
    return facts


def _card_text(ctx: EvalContext) -> str:
    """Все строки карточки сценария: что обучаемый видит, не спрашивая."""
    texts: list[str] = []

    def walk(value: Json) -> None:
        if isinstance(value, str):
            texts.append(value)
        elif isinstance(value, dict):
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    walk(ctx.scenario.get("card"))
    return "\n".join(texts)


def _in_text(checker: TextChecker, fact: Fact, text: str) -> bool:
    """Пункт есть в тексте (карточки или реплики) — по начальным формам, без опечаток."""
    pool = _lemmas(checker, text)
    return CommentKeywordsCriterion._found(checker, fact, text, pool, pool)


def _sourced(
    ctx: EvalContext, checker: TextChecker, fact: Fact, reported: Sequence[datetime] = ()
) -> Fact:
    """Источник сведения (HQ-020): карточка — всегда; разговор — с первого предъявления.

    `reported` — когда прозвучали доклады, которые добавили пункт переменой задачи: их пункт —
    из разговора, даже если слов пункта в реплике нет («112» после «нужны пожарные»).
    Источник — разговор, если пункт есть в предъявленной реплике или в докладе плана
    (`planned`: должен был прозвучать); непредъявленная реплика ветки или события — нет.
    heard_at = min(предъявление реплик с пунктом ∪ `reported`); ни одна не предъявлена — None.
    """
    if _in_text(checker, fact, _card_text(ctx)):
        return fact
    times = list(reported)
    spoken = bool(reported)
    for line in ctx.lines:
        text = line.get("text")
        if not isinstance(text, str) or not _in_text(checker, fact, text):
            continue
        at = _time(line.get("presented_at"))
        if at is not None:
            spoken = True
            times.append(at)
        elif line.get("planned") is True:
            # Доклад плана должен был прозвучать: не прозвучал — карточку не довели.
            spoken = True
        # Реплика ветки или события, которая не сработала, источником не делает:
        # сведение могли узнать иначе (звонок заявителю, фраза окна телефона).
    if not spoken:
        return fact
    return replace(fact, conversation=True, heard_at=min(times, default=None))


def _task_change_keywords(ctx: EvalContext) -> dict[str, list[datetime]]:
    """Ключевые слова перемен задачи → когда прозвучал доклад, который их добавил (TC-05)."""
    found: dict[str, list[datetime]] = {}
    for planned in ctx.planned_messages:
        change = planned.get("task_change")
        at = _time(planned.get("presented_at"))
        if not isinstance(change, dict) or at is None:
            continue
        keywords = change.get("comment_keywords")
        for item in keywords if isinstance(keywords, list) else []:
            if isinstance(item, str) and item.strip():
                found.setdefault(item.strip(), []).append(at)
    return found


def _answered_at(ctx: EvalContext) -> dict[str, datetime]:
    """Номер регистрации → когда ответили на звонок, в котором его назвали."""
    answered = {
        _call_key(call.get("id")): at
        for call in ctx.calls
        if (at := _time(call.get("answered_at"))) is not None
    }
    found: dict[str, datetime] = {}
    for event in ctx.events:
        payload = event.get("payload")
        if event.get("type") not in {"call_hold", "call_hangup"} or not isinstance(payload, dict):
            continue
        number = payload.get("registration_number")
        at = answered.get(_call_key(payload.get("call_id")))
        if isinstance(number, str) and at is not None:
            found[number] = min(at, found.get(number, at))
    return found


def _timed_comments(ctx: EvalContext) -> list[tuple[str, datetime | None]]:
    """Комментарии диспетчера и когда сохранены (`server_ts`); None — текущий, в конце."""
    timed: list[tuple[str, datetime | None]] = []
    for event in ctx.events:
        payload = event.get("payload")
        if event.get("type") in ("status_change", "redirect", "comment") and isinstance(
            payload, dict
        ):
            text = payload.get("comment")
            if isinstance(text, str) and text.strip():
                timed.append((text, _time(event.get("server_ts"))))
    current = ctx.current.get("comment")
    if isinstance(current, str) and current.strip() and all(t != current for t, _ in timed):
        timed.append((current, None))
    return timed


def _reason_said(
    ctx: EvalContext, checker: TextChecker, comment: str, exact: set[str], fuzzy: set[str]
) -> bool:
    """Суть происшествия своими словами — то же правило, что повод в докладе и вводной."""
    from evalcore.report import reason_said  # report импортирует comment

    return reason_said(ctx.scenario, comment, checker, (exact, fuzzy))


def registrations(ctx: EvalContext) -> list[tuple[str, str]]:
    """Номера регистрации, названные должностными лицами в отвеченных звонках (TC-03).

    Номер — из снимка удержания или отбоя (`registration_number`); один номер — один пункт.
    """
    answered = {
        _call_key(call.get("id")): str(call.get("phone_ext") or call.get("service_id") or "")
        for call in ctx.calls
        if isinstance(call.get("answered_at"), str)
    }
    found: dict[str, str] = {}
    for event in ctx.events:
        payload = event.get("payload")
        if event.get("type") not in {"call_hold", "call_hangup"} or not isinstance(payload, dict):
            continue
        number = payload.get("registration_number")
        call_id = _call_key(payload.get("call_id"))
        if isinstance(number, str) and number.isdigit() and call_id in answered:
            found.setdefault(number, answered[call_id])
    return [(phone_ext, number) for number, phone_ext in found.items()]


class CommentKeywordsCriterion:
    """Ключевые сведения комментария: адрес, суть, решение, пострадавшие, слова эталона.

    Балл = |пункты, найденные в комментарии и прозвучавшие до его записи| / |пункты|. Пункт из
    разговора (`Fact.conversation`) ищется только в комментариях с `server_ts` ≥ `heard_at`.
    """

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
        timed = _timed_comments(ctx)
        found: list[str] = []
        guessed: list[str] = []
        for fact in facts:
            if not self._found(checker, fact, comment, exact, fuzzy) and not (
                fact.reason and _reason_said(ctx, checker, comment, exact, fuzzy)
            ):
                continue
            if not fact.conversation:
                found.append(fact.label)
                continue
            heard_at = fact.heard_at
            if heard_at is None:
                guessed.append(f"«{fact.label}» — в разговоре не прозвучало — не засчитано")
                continue
            after = "\n".join(text for text, at in timed if at is None or at >= heard_at)
            if after.strip() and self._found(
                checker, fact, after, *self._comment_lemmas(checker, after)
            ):
                found.append(fact.label)
            else:
                guessed.append(
                    f"«{fact.label}» — записано до того, как прозвучало в разговоре, — не засчитано"
                )
        missing = [fact.label for fact in facts if fact.label not in found]
        lost = [fact for fact in facts if fact.label not in found]
        score = len(found) / len(facts)
        explanation = (
            "Все ключевые сведения есть в комментарии."
            if not missing
            else "Комментарий пуст: ключевые сведения не переданы."
            if not comment.strip()
            else f"В комментарии не хватает сведений: {len(missing)} из {len(facts)}."
        )
        if guessed:
            explanation += (
                f" Не засчитано сведений, которые в разговоре ещё не прозвучали: {len(guessed)}"
                " — сведения из докладов пишут после доклада, а не угадывают."
            )
        return CriterionResult(
            self.key,
            score,
            weight,
            False,
            [
                f"Есть: {'; '.join(found) or 'нет'}",
                f"Не хватает: {'; '.join(missing) or 'нет'}",
                *guessed,
            ],
            explanation,
            (remarks.comment_facts_missing([(fact.kind, fact.label) for fact in lost]),)
            if lost
            else (),
        )

    @staticmethod
    def _comment_lemmas(checker: TextChecker, comment: str) -> tuple[set[str], set[str]]:
        """Начальные формы слов комментария; fuzzy — ещё и исправленных опечаток."""
        exact = _lemmas(checker, comment)
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
        if matched < fact.need and not _repeats_card(checker, fact.card_words, pool):
            return False
        if fact.number and not registration_said(comment, fact.number):
            return False
        street = [word for group in fact.groups if len(group) == 1 for word in group]
        return not fact.house or house_said(comment, fact.house, street, fact.building)


def _repeats_card(checker: TextChecker, words: tuple[str, ...], pool: set[str]) -> bool:
    """Комментарий повторяет не меньше половины значимых слов описания карточки."""
    if not words:
        return False
    found = sum(1 for word in words if _variant_found(checker, word, pool))
    return found * 2 >= len(words)


# «дом 24», «в доме 24», «дом номер 24», «д. № 24» — слово дома в любом падеже и номер.
_HOUSE_WORD = r"(?<![0-9а-я])(?:дом[а-я]{0,2}|д)\.?(?:\s*(?:номер|№))?"
# Номер перед словом «дом» — только порядковый: «24-й дом», «в 24-м доме» (распознанное
# «двадцать четвёртый дом» `voice_reply.spoken_numbers` пишет «24-й дом»). Количественное
# «24 дом» — чаще хвост другого номера: «квартира 24 дом 7».
_ORDINAL_SUFFIX = r"-?(?:й|ый|ий|ой|го|ого|ому|ему|м|ом|ем)"
# Номер после этих слов — не дом: «квартира 24», «подъезд 2», «этаж 5», «корпус 1».
_NOT_HOUSE = re.compile(
    r"(?<![0-9а-я])(?:квартир[а-я]*|кв|подъезд[а-я]*|этаж[а-я]*|эт|корпус[а-я]*|корп"
    r"|строени[а-я]*|стр)\.?\s*(?:номер\s*|№\s*)?$"
)


# Слово места сразу после номера и без своего номера: «24 подъезд», «24-й этаж» — номер не дом
# («24, квартира 115» — дом 24 и квартира 115). Точка сокращения входит в границу слова:
# иначе regex откатывается перед ней и принимает «24, кв. 115» за «24 кв.» без номера.
_PLACE_AFTER = re.compile(
    r"-?[а-я]{0,3}[.,]?\s*(?:квартир[а-я]*|кв|подъезд[а-я]*|этаж[а-я]*|эт)\.?(?![а-я.])"
    r"(?!\s*(?:номер\s*|№\s*)?\d)"
)
# Корпус или строение сразу после дома: «98 корпус 3», «98, к. 2», «98 строение 2».
_BUILDING = re.compile(
    r"[.,]?\s*(?:корпус[а-я]*|корп|к|строени[а-я]*|стр)\.?\s*(?:номер\s*|№\s*)?(\d+)(?!\d)"
)


def house_said(text: str, house: str, street: Sequence[str] = (), building: str = "") -> bool:
    """Номер дома прозвучал как дом — одно правило для комментария, доклада службе, вводной
    и ответа бригаде (`report`, `briefing`, `voice_reply`).

    Засчитывается: после «дом», «д.» («дом 24», «в доме 24», «дом номер 24»), сразу после
    названия улицы `street` («Дубнинская 1», «Бескудниковский бульвар, 24») или порядковым
    перед словом «дом» («24-й дом»). Номер после «квартира», «подъезд», «этаж», «корпус»,
    «строение» — не дом: «Бескудниковский бульвар квартира 24 дом 7» — дом 7, а не 24. Номер
    после улицы, за которым сразу «подъезд», «квартира», «этаж» без своего номера, — тоже не
    дом: «Бескудниковский бульвар, 24 подъезд» (`_PLACE_AFTER`). Корпус `building` сверяется,
    если назван сразу после дома: «Профсоюзная 98 корпус 3» при корпусе 2 — другой дом; не
    назван — дом засчитан.
    """
    text = _clean(text)
    number = re.escape(_clean(house))
    if not number:
        return False
    expected = _clean(building).strip()

    def building_ok(end: int) -> bool:
        spoken = _BUILDING.match(text, end)
        return not expected or spoken is None or spoken.group(1) == expected

    tail = rf"\.?\s*{number}(?![0-9а-я])"
    if any(building_ok(match.end()) for match in re.finditer(rf"{_HOUSE_WORD}{tail}", text)):
        return True
    for match in re.finditer(
        rf"(?<![0-9]){number}{_ORDINAL_SUFFIX}\s+дом[а-я]{{0,2}}(?![а-я])", text
    ):
        if not _NOT_HOUSE.search(text[: match.start()]) and building_ok(match.end()):
            return True
    for word in street:
        stem = re.escape(_clean(word)[:5])
        if not stem:
            continue
        for match in re.finditer(rf"{stem}[а-я-]*{_AFTER_STREET}{tail}", text):
            if not _PLACE_AFTER.match(text, match.end()) and building_ok(match.end()):
                return True
        # Номер перед улицей: «двадцать четыре, Бескудниковского бульвара», «24 по Профсоюзной».
        before = rf"(?<![0-9]){number}(?![0-9а-я])[.,]?\s+(?:по\s+)?{_BEFORE_STREET}{stem}"
        for match in re.finditer(before, text):
            if not _NOT_HOUSE.search(text[: match.start()]):
                return True
    return False


def _lemmas(checker: TextChecker, text: str) -> set[str]:
    """Слова текста и их начальные формы, без исправления опечаток."""
    found: set[str] = set()
    for word in _words(text):
        found |= checker.lemmas(word)
        found.add(_clean(word))
    # Числа — отдельными словами: ключевое слово «112» не находится в «1123».
    found.update(_numbers(text))
    return found


def _variant_found(checker: TextChecker, variant: str, pool: set[str]) -> bool:
    """Все слова варианта есть в комментарии (по начальной форме); число — целиком («112»)."""
    words = _words(variant)
    numbers = _numbers(variant)
    if not words and not numbers:
        return False
    return all(number in pool for number in numbers) and all(
        _clean(word) in pool or bool(checker.lemmas(word) & pool) for word in words
    )


COMMENT_REGISTRY: dict[str, Criterion] = {
    criterion.key: criterion for criterion in (SpellingCriterion(), CommentKeywordsCriterion())
}
assert tuple(COMMENT_REGISTRY) == COMMENT_CRITERIA
