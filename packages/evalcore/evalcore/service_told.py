"""Общий ограниченный разбор вести о службе: факт, намерение и локальное отрицание.

Конечные словоформы и маркеры находятся в service_language.json. Здесь нет проверки
реального звонка или срока: они принадлежат потребителям. Корпус задаёт границы грамматики.
"""

import json
import re
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Literal, TypedDict

from evalcore.models import Json

LANGUAGE = json.loads(Path(__file__).with_name("service_language.json").read_text())
ALREADY_OPTION = "already"
CALLING_OPTION = "calling"
State = Literal["called", "calling", "denied"]


class ServiceClaim(TypedDict):
    services: list[str]
    state: State
    named: bool


class ServiceIntent(TypedDict):
    claims: list[ServiceClaim]
    services: list[str]
    called: bool
    option: str | None


def _tokens(text: str) -> list[str]:
    return re.findall(LANGUAGE["token_pattern"], text.lower().replace("ё", "е"))


def _phrases(values: Iterable[str]) -> list[tuple[str, ...]]:
    return sorted({tuple(_tokens(value)) for value in values}, key=lambda p: (-len(p), p))


_SERVICE_PHRASES = {ext: _phrases(values) for ext, values in LANGUAGE["services"].items()}
_PREDICATES = [
    (phrase, state)
    for state, values in LANGUAGE["predicates"].items()
    for phrase in _phrases(values)
]
_PREDICATES.sort(key=lambda item: (-len(item[0]), item[0]))
# Совместимость внешних импортов: теперь только полные конечные словоформы.
SERVICE_WORDS: dict[str, re.Pattern[str]] = {
    ext: re.compile(r"\b(?:" + "|".join(re.escape(v) for v in values) + r")\b")
    for ext, values in LANGUAGE["services"].items()
}


def _matches(tokens: list[str], phrases: list[tuple[str, ...]]) -> list[tuple[int, int]]:
    result = []
    i = 0
    while i < len(tokens):
        phrase = next((p for p in phrases if tuple(tokens[i : i + len(p)]) == p), None)
        if phrase:
            result.append((i, i + len(phrase)))
            i += len(phrase)
        else:
            i += 1
    return result


def _expected(phone_exts: Iterable[str]) -> list[str]:
    return sorted(
        {
            ext
            for value in phone_exts
            if (ext := LANGUAGE["aliases"].get(str(value), str(value))) in _SERVICE_PHRASES
        }
    )


def _has_phrase(tokens: list[str], values: list[str]) -> bool:
    return bool(_matches(tokens, _phrases(values)))


def _clauses(text: str) -> Iterable[list[str]]:
    # Вопросная вводная относится ко всем её запятым, но не к следующему предложению.
    for sentence in re.finditer(r"([^.!?;\n]+)([.!?;\n]*)", text):
        body, ending = sentence.groups()
        tokens = _tokens(body)
        if "?" in ending or any(
            tokens[: len(p)] == list(p) for p in _phrases(LANGUAGE["question_heads"])
        ):
            continue
        current: list[str] = []
        for part in re.split(r",", body):
            for token in _tokens(part):
                if token in LANGUAGE["clause_breaks"]:
                    if current:
                        yield current
                    current = []
                else:
                    current.append(token)
            if current:
                yield current
            current = []


def parse_service_intent(text: str, phone_exts: Iterable[str] = ()) -> ServiceIntent:
    """Разобрать утверждения слева направо; последнее состояние каждой службы побеждает.

    services — все явно/контекстно подтверждённые службы (канонические номера), called и
    option — только подходящие phone_exts. Пустой контекст допускает безымянный ответ;
    неоднозначный непустой — нет. claims с пустыми services не получают выдуманной личности.
    """
    supplied = tuple(phone_exts)
    expected = _expected(supplied)
    claims: list[ServiceClaim] = []
    inherited: list[str] = []
    for tokens in _clauses(text.lower().replace("ё", "е")):
        mentions = sorted(
            (start, end, ext)
            for ext, phrases in _SERVICE_PHRASES.items()
            for start, end in _matches(tokens, phrases)
        )
        # Более длинное название главнее: «участковый врач», не полиция.
        mentions = [
            m
            for m in mentions
            if not any(
                n[0] <= m[0] and m[1] <= n[1] and n[1] - n[0] > m[1] - m[0] for n in mentions
            )
        ]
        if _has_phrase(tokens, LANGUAGE["modality"]):
            # Не наследуем адресата из просьбы/гипотезы.
            continue
        predicates: list[tuple[int, int, State]] = []
        i = 0
        while i < len(tokens):
            match = next(
                ((p, state) for p, state in _PREDICATES if tuple(tokens[i : i + len(p)]) == p),
                None,
            )
            if match:
                phrase, state = match
                predicates.append((i, i + len(phrase), state))
                i += len(phrase)
            else:
                i += 1
        previous_end = 0
        for start, end, state in predicates:
            # Отрицание отмены не отменяет ранее сообщённый вызов.
            if state == "denied" and any(
                t in LANGUAGE["negation"] for t in tokens[previous_end:start]
            ):
                previous_end = end
                continue
            if mentions:
                # Между двумя предикатами новая служба ближе к своему предикату.
                def distance(
                    mention: tuple[int, int, str], start: int = start, end: int = end
                ) -> int:
                    return max(mention[0] - end, start - mention[1], 0)

                nearest = min(mentions, key=lambda m: (distance(m), m[0]))
                targets = {nearest[2]}
                # «Скорую и полицию вызвал»: координация, а не второй независимый факт.
                for mention in mentions:
                    left, right = sorted((nearest, mention))
                    gap = tokens[left[1] : right[0]]
                    if all(t in {"и", "или"} for t in gap):
                        targets.add(mention[2])
                services = sorted(targets)
                named = True
                # «Вызвал не пожарных»: отрицание адресата после предиката.
                # Эллипсис «а скорую» без своего предиката консервативно не подтверждаем.
                if any(t in LANGUAGE["negation"] for t in tokens[end : nearest[0]]):
                    state = "denied"
            elif inherited:
                services, named = inherited[:], True
            else:
                services, named = (expected[:] if len(expected) == 1 else []), False
            if any(t in LANGUAGE["negation"] for t in tokens[previous_end:start]):
                state = "denied"
            claims.append({"services": services, "state": state, "named": named})
            previous_end = end
        if mentions:
            inherited = sorted({m[2] for m in mentions})
    final: dict[str, ServiceClaim] = {}
    for claim in claims:
        for ext in claim["services"] or [""]:
            final[ext] = claim
    services = sorted(ext for ext, claim in final.items() if ext and claim["state"] == "called")
    selected = [claim for ext, claim in final.items() if (ext in expected if supplied else True)]
    called = any(claim["state"] == "called" for claim in selected)
    option = (
        ALREADY_OPTION
        if called
        else (CALLING_OPTION if any(claim["state"] == "calling" for claim in selected) else None)
    )
    return {"claims": claims, "services": services, "called": called, "option": option}


def says_service_called(text: str, phone_exts: Iterable[str], *, named: bool) -> bool:
    """Факт нужной службы; до просьбы требуется явно названная личность службы."""
    exts = tuple(phone_exts)
    result = parse_service_intent(text, exts)
    if not named:
        if result["called"]:
            return True
        # Опубликованная общая кнопка «Служба вызвана» не несёт ключа/mode.
        # Потребитель проверяет ВСЕ реальные звонки; свободная UI-маршрутизация
        # должна использовать parse_service_intent, где неоднозначность сохранена.
        if result["claims"] and all(not claim["services"] for claim in result["claims"]):
            return parse_service_intent(text)["called"]
        return False
    expected = _expected(exts)
    final = {}
    for claim in result["claims"]:
        for ext in claim["services"]:
            final[ext] = claim
    return any(
        ext in expected and claim["named"] and claim["state"] == "called"
        for ext, claim in final.items()
    )


def service_reply_option(
    options: Sequence[dict[str, Json]], text: str, phone_exts: Iterable[str] = ()
) -> str | None:
    """Смысловой ключ только среди предложенных already/calling, без label-match."""
    option = parse_service_intent(text, phone_exts)["option"]
    return option if option in {item.get("key") for item in options} else None


def reply_says_service_called(reply: dict[str, Json], phone_exts: Iterable[str]) -> bool:
    """Ручной/исторический already совместим; непустой голос всегда проверяется по смыслу."""
    text = str(reply.get("text") or "").strip()
    if reply.get("option_key") == ALREADY_OPTION and (reply.get("mode") != "voice" or not text):
        return True
    return says_service_called(text, phone_exts, named=False)
