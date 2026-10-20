"""Живой заявитель в прогоне — правила окна телефона (`apps/web/src/arm/softphone/caller/
conversation.ts`, HQ-019, docs/dds_caller.md) для расшифровки.

Что отвечает заявитель, решает браузер; прогону правила нужны, чтобы диспетчер-политика
говорил с тем же собеседником, что и обучаемый, и слал те же отметки `caller_said`. Фразы — из
`bankPhrases.json` (тот же файл, что у клиента). Правила с клиентом общие по таблице примеров
`apps/web/src/arm/softphone/caller/conversation.cases.json`: её проверяют и vitest, и pytest
(`test_coherence_caller.py`), так правила не расходятся. Что услышано во фразе диспетчера —
`hear`, зеркало `hearing.ts`: политика говорит те же вопросы, что кнопки окна (таблица сюжета
`callerPlots`), и заявитель понимает их по тем же словам; общая таблица примеров распознавания —
`hearing.cases.json`.
"""

import re
from dataclasses import dataclass, field, replace
from typing import Any

from app.tools.coherence import phone

# Константы клиента (conversation.ts) — те же значения.
NO_REPLY_S = 8.0  # NO_REPLY_MS: тишина диспетчера после реплики заявителя
HANGUP_PAUSE = 3  # третья пауза подряд — отбой заявителя
MAX_ANSWERS = 3  # спокойная отвечает не больше чем на три вопроса фразы
CHARACTERS = {"calm": "CALLER_CALM", "confused": "CALLER_CONFUSED"}


@dataclass(frozen=True)
class Heard:
    """Что заявитель понял из фразы: вопросы (сведения, `readback:<дом>:<кв>`, come, bye,
    other, again), названы ли служба и повод, «да»."""

    asks: tuple[str, ...] = ()
    service: bool = False
    reason: bool = False
    yes: bool = False


def plots() -> dict[str, Any]:
    """Таблицы сюжетов заявителя (`callerPlots` bankPhrases.json, web.py: callers/plots/)."""
    return dict(phone.bank()["callerPlots"])


# Общие слова распознавания (hearing.ts) — те же выражения.
_COMMON = (
    (
        "come",
        r"подойдите|подходите|приходите|идите к|спуститесь|откройте|откроете дверь"
        r"|бригад\S* (ждет|ждут|стоит|стоят|у двери)",
    ),
    ("bye", r"до свидания|всего доброго|всего хорошего"),
)
_SERVICE = re.compile(r"жкх|аварийн|диспетчер|служб|управляющ|коммунальн|ддс|сантехник")
_REASON = re.compile(r"заявк|вызов|обращени")
_YES = re.compile(r"^(да|так|верно|точно|ага|правильно)(?![а-я])")
_AGAIN = re.compile(r"повторите|еще раз|не расслышал|не понял")
# Вопросительное слово — вопрос и во фразе со службой и поводом; один «?» при названной
# службе — представление с переспросом (как QUESTION_WORD в hearing.ts).
_QUESTION_WORD = re.compile(
    r"(?<![а-я])(что|как|какой|какая|сколько|где|когда|почему|кто|чей|ли)(?![а-я])"
)
_ADDRESS_WORDS = re.compile(r"(?<![а-я])(дом|д\.|квартир|кв(?![а-я])|улиц|ул(?![а-я]))")
_TEENS = {
    "десять": 10,
    "одиннадцать": 11,
    "двенадцать": 12,
    "тринадцать": 13,
    "четырнадцать": 14,
    "пятнадцать": 15,
    "шестнадцать": 16,
    "семнадцать": 17,
    "восемнадцать": 18,
    "девятнадцать": 19,
}
_TENS = (
    (r"^двадцат", 20),
    (r"^тридцат", 30),
    (r"^сорок", 40),
    (r"^пят(ь|и)десят", 50),
    (r"^шест(ь|и)десят", 60),
    (r"^сем(ь|и)десят", 70),
    (r"^вос(емь|ьми)десят", 80),
    (r"^девяност", 90),
)
_UNITS = (
    (r"^(один|одна|одно|перв)", 1),
    (r"^(два|две|втор)", 2),
    (r"^(три|трет)", 3),
    (r"^(четыре|четверт)", 4),
    (r"^(пять|пят(ый|ая|ое|ого|ой|ую|ом))$", 5),
    (r"^(шесть|шест(ой|ая|ое|ого|ую|ом))$", 6),
    (r"^(семь|седьм)", 7),
    (r"^(восемь|восьм)", 8),
    (r"^(девять|девят(ый|ая|ое|ого|ой|ую|ом))$", 9),
)


def _norm(text: str) -> str:
    return text.lower().replace("ё", "е")


def _unit(word: str) -> int | None:
    return next((value for pattern, value in _UNITS if re.search(pattern, word)), None)


def numbers_in(text: str) -> list[tuple[int, int]]:
    """Числа во фразе по порядку (значение, место): «22», «двадцать два», «пятьдесят восьмая»."""
    found: list[tuple[int, int]] = []
    words = list(re.finditer(r"[0-9]+|[а-я]+", _norm(text)))
    index = 0
    while index < len(words):
        match = words[index]
        word = match.group()
        tens = next((value for pattern, value in _TENS if re.search(pattern, word)), None)
        if word.isdigit():
            found.append((int(word), match.start()))
        elif word in _TEENS:
            found.append((_TEENS[word], match.start()))
        elif tens is not None:
            unit = _unit(words[index + 1].group()) if index + 1 < len(words) else None
            if unit is not None:
                index += 1
            found.append((tens + (unit or 0), match.start()))
        elif (unit := _unit(word)) is not None:
            found.append((unit, match.start()))
        index += 1
    return found


def _read_address(said: str, numbers: list[tuple[int, int]]) -> str:
    house: int | None = None
    flat: int | None = None
    rest: list[int] = []
    for value, at in numbers:
        before = said[max(0, at - 12) : at]
        if re.search(r"(квартир\S*|кв\.?)\s*$", before):
            flat = value
        elif re.search(r"(?<![а-я])(дом\S*|д\.?)\s*$", before):
            house = value
        else:
            rest.append(value)
    for value in rest:
        if house is None:
            house = value
        elif flat is None:
            flat = value
    return f"readback:{'' if house is None else house}:{'' if flat is None else flat}"


def hear(text: str, plot: str, street: str = "") -> Heard:
    """Что заявитель понял из фразы диспетчера (`hearing.ts`): вопросы по месту во фразе —
    общие и сведения таблицы сюжета, адрес вслух, служба, повод, «да»."""
    table = plots()[plot]
    said = _norm(text)
    patterns = [*_COMMON, *((fact, item["hear"]) for fact, item in table["facts"].items())]
    found = [(m.start(), ask) for ask, pattern in patterns if (m := re.search(pattern, said))]
    asks = [ask for _, ask in sorted(found, key=lambda item: item[0])]
    numbers = numbers_in(said)
    street_word = _norm(street).split()[0] if street.strip() else ""
    address_said = bool(_ADDRESS_WORDS.search(said)) or (
        len(street_word) > 4 and street_word[:-2] in said
    )
    if numbers and address_said:
        at = asks.index("address") if "address" in asks else 0
        asks = [ask for ask in asks if ask != "address"]
        asks.insert(at, _read_address(said, numbers))
    service = bool(_SERVICE.search(said))
    reason = bool(_REASON.search(said) or re.search(table["reason"], said))
    if not asks and _AGAIN.search(said):
        asks = ["again"]
    if not asks and (_QUESTION_WORD.search(said) or ("?" in said and not service)):
        asks = ["other"]
    return Heard(tuple(asks), service, reason, bool(_YES.search(said.strip())))


@dataclass(frozen=True)
class Memory:
    facts: dict[str, str] = field(default_factory=dict)
    came: bool = False
    repeats: int = 0
    service: bool = False
    reason: bool = False
    asked_who: int = 0
    pending: tuple[str, ...] = ()
    silence: int = 0
    calls: int = 0
    dropped: bool = False
    turn: int = 0
    last: tuple[dict[str, Any], ...] = ()


@dataclass(frozen=True)
class Book:
    id: str
    character: str
    plot: str

    def slot(self, slot: str) -> list[dict[str, Any]]:
        phrases = phone.books()[self.id]["slots"].get(slot, [])
        return [p for p in phrases if not p.get("only") or self.plot in p["only"].split(",")]


@dataclass(frozen=True)
class Turn:
    memory: Memory
    lines: tuple[dict[str, Any], ...]
    hangup: bool = False


def book(character: str, plot: str) -> Book:
    return Book(CHARACTERS[character], character, plot)


def facts_of(phrase: dict[str, Any]) -> list[str]:
    if not phrase.get("tells") or phrase.get("on") == "first":
        return []
    return str(phrase["tells"]).split(",")


def _pick(phrases: list[dict[str, Any]], memory: Memory) -> dict[str, Any] | None:
    if not phrases:
        return None
    last = memory.last[-1]["id"] if memory.last else None
    for shift in range(len(phrases)):
        phrase = phrases[(memory.turn + shift) % len(phrases)]
        if phrase["id"] != last or len(phrases) == 1:
            return phrase
    return phrases[0]


def _staged(phrases: list[dict[str, Any]], on: str) -> list[dict[str, Any]]:
    return [p for p in phrases if p.get("on") == on]


def pick_up(caller: Book, memory: Memory) -> Turn:
    again = memory.calls > 0 and memory.dropped
    phrase = _pick(caller.slot("answer_again" if again else "answer"), memory)
    lines = (phrase,) if phrase else ()
    return Turn(
        replace(
            memory,
            calls=memory.calls + 1,
            silence=0,
            dropped=False,
            turn=memory.turn + 1,
            last=lines,
        ),
        lines,
    )


def hung_up(memory: Memory, farewell: bool) -> Memory:
    return replace(memory, silence=0, dropped=not farewell)


def silence(caller: Book, memory: Memory) -> Turn:
    streak = memory.silence + 1
    if streak >= HANGUP_PAUSE:
        phrase = _pick(caller.slot("hangup"), memory)
        lines = (phrase,) if phrase else ()
        return Turn(replace(memory, silence=0, dropped=True, last=lines), lines, True)
    asks = caller.slot("no_reply")
    found = asks[min(streak, len(asks)) - 1] if asks else None
    lines = (found,) if found else ()
    return Turn(replace(memory, silence=streak, last=lines), lines)


def _tell(caller: Book, memory: Memory, fact: str) -> tuple[list[dict[str, Any]], Memory]:
    phrases = caller.slot(f"tell_{fact}")
    first, again = _staged(phrases, "first"), _staged(phrases, "again")
    full = again or [p for p in phrases if not p.get("on")]
    said = memory.facts.get(fact)
    if said is None and first:
        phrase = _pick(first, memory)
        return ([phrase] if phrase else []), replace(memory, facts={**memory.facts, fact: "first"})
    answer = _pick(full, memory)
    lines: list[dict[str, Any]] = []
    if said == "full":
        repeats = caller.slot("repeat")
        ordered = (
            _staged(repeats, "first" if memory.repeats == 0 else "again")
            if _staged(repeats, "first")
            else repeats
        )
        repeat = _pick(ordered, memory)
        if repeat:
            lines.append(repeat)
        memory = replace(memory, repeats=memory.repeats + 1)
    if answer:
        lines.append(answer)
    return lines, replace(memory, facts={**memory.facts, fact: "full"})


def _digits(value: str) -> str:
    return re.sub(r"\D", "", value)


def _readback(caller: Book, memory: Memory, ask: str, address: tuple[str, str]) -> Any:
    _, house, flat = ask.split(":")
    wrong_house = bool(house) and _digits(house) != _digits(address[0])
    wrong_flat = bool(flat) and _digits(flat) != _digits(address[1])
    wrong = "house" if wrong_house else "flat" if wrong_flat else None
    if wrong is None:
        return _pick(caller.slot("confirm_address"), memory)
    fixes = caller.slot("correct_address")
    return next((p for p in fixes if p.get("wrong") == wrong), _pick(fixes, memory))


def _answer(
    caller: Book, memory: Memory, ask: str, address: tuple[str, str]
) -> tuple[list[dict[str, Any]], Memory, bool]:
    if ask.startswith("readback:"):
        phrase = _readback(caller, memory, ask, address)
        return (
            [phrase] if phrase else [],
            replace(memory, facts={**memory.facts, "address": "full"}),
            False,
        )
    required = plots()[caller.plot].get("come_requires", [])
    if ask == "come":
        if any(memory.facts.get(fact) != "full" for fact in required):
            return [], memory, False
        phrase = _pick(caller.slot("agree"), memory)
        return ([phrase] if phrase else []), replace(memory, came=True), False
    if ask == "bye" and required and not memory.came:
        return [], memory, True
    simple = {"bye": "end_call", "other": "unknown"}
    if ask in simple:
        phrase = _pick(caller.slot(simple[ask]), memory)
        return ([phrase] if phrase else []), memory, ask == "bye"
    if ask == "again":
        return list(memory.last), memory, False
    lines, memory = _tell(caller, memory, ask)
    return lines, memory, False


def _asks_who(caller: Book, memory: Memory, heard: Heard) -> dict[str, Any] | None:
    service, reason = heard.service, heard.reason
    known = service and reason if caller.character == "confused" else service
    if known or (caller.character == "calm" and memory.asked_who > 0):
        return None
    phrases = caller.slot("ask_who")
    if reason and not service and len(phrases) > 1:
        return phrases[1]
    return phrases[0] if phrases else None


def reply(caller: Book, memory: Memory, heard: Heard, address: tuple[str, str]) -> Turn:
    guess = caller.slot("ask_who")[1]["id"] if len(caller.slot("ask_who")) > 1 else None
    guessed = heard.yes and any(p["id"] == guess for p in memory.last)
    memory = replace(
        memory,
        silence=0,
        service=memory.service or heard.service or guessed,
        reason=memory.reason or heard.reason or guessed,
    )
    who = _asks_who(caller, memory, replace(heard, service=memory.service, reason=memory.reason))
    if who:
        lines: tuple[dict[str, Any], ...] = (who,)
        pending = memory.pending + tuple(ask for ask in heard.asks if ask != "again")
        return Turn(
            replace(
                memory,
                asked_who=memory.asked_who + 1,
                pending=pending,
                turn=memory.turn + 1,
                last=lines,
            ),
            lines,
        )
    asks = memory.pending + heard.asks
    memory = replace(memory, pending=())
    if not asks:
        if heard.service or heard.reason or heard.yes:
            return Turn(memory, ())
        phrase = _pick(caller.slot("not_understood"), memory)
        lines = (phrase,) if phrase else ()
        return Turn(replace(memory, turn=memory.turn + 1, last=lines), lines)
    taken = asks[:1] if caller.character == "confused" else asks[:MAX_ANSWERS]
    said: list[dict[str, Any]] = []
    hangup = False
    for ask in taken:
        lines_, memory, leave = _answer(caller, memory, ask, address)
        said += lines_
        memory = replace(memory, turn=memory.turn + 1)
        if leave:
            hangup = True
            break
    return Turn(replace(memory, last=tuple(said) or memory.last), tuple(said), hangup)
