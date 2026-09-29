"""Заявитель по правилам: паника 0–3 от действий оператора, без генерации (Q29).

Состояние неизменяемо, `act` — чистая функция: одинаковые действия дают одинаковый
результат, это нужно оценке и тестам. Правила — contracts/operator/dialog.md.

Этап 2 (docs/operator_112_review/PLAN.md): порог истерии и приём «Успокоить» — метод
повторяющейся настойчивости IAED; пауза оператора; ухудшение ситуации посреди звонка;
советы; ключ голосового файла у каждой реплики.

Этап 3: шаги опроса APCO/NENA (вопрос раньше адреса злит заявителя), повтор адреса вслух —
заявитель сверяет его с тем, что знает, лишние вопросы шагов и ход шагов для экрана.
"""

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, replace
from typing import Any, Literal

from evalcore.address import address_components_match  # type: ignore[import-untyped]

from app.operator.scenarios import load_questionnaires

PANIC_MIN = 0
PANIC_MAX = 3
PANIC_START = 1
# С этого уровня заявитель отвечает паническим вариантом и факт не считается полученным.
PANIC_THRESHOLD = 2
# Истерика — выше порога истерии (IAED): вопросы и советы не слышны, помогает только
# просьба с причиной, повторённая подряд.
PANIC_HYSTERIA = 3

# Шаги опроса (contracts/operator/questionnaire.schema.json): 1 — адрес, 2 — номер для
# обратной связи, 3 — что случилось, 4 — угроза людям, 5 — детали и доступ.
STEPS = (1, 2, 3, 4, 5)
ADDRESS_STEP = 1
# Вопросы карты с особым смыслом: адрес, его повтор вслух, номер для связи, ориентир.
ADDRESS_KEY = "address"
CONFIRM_KEY = "confirm_address"
CALLBACK_KEY = "callback"
LANDMARK_KEY = "landmark"
# Что заявитель сверяет на слух при повторе адреса, кроме улицы: дом, корпус, квартира — те,
# что есть в адресе сценария (у ДТП на проспекте квартиры нет).
CONFIRM_DETAILS = ("house", "building", "apartment")

REPLY_WRONG_CALL = "Извините, номер набран случайно, у нас ничего не случилось."

ACTIONS = ("question", "calm", "hold", "silence", "advice", "escalate")
# «Успокоить»: просьба с причиной (IAED), мягкая поддержка без просьбы, приказ без причины.
CALM_KINDS = ("reason", "soft", "order")
Outcome = Literal[
    "correct",
    "early",
    "repeated",
    "irrelevant",
    "not_understood",
    "no_incident",
    "unheard",
    "calming",
    "calmed",
    "order",
    "hold",
    "silence",
    "advice",
    "escalation",
    "confirmed",
    "corrected",
    "unconfirmed",
    "noop",
]

_STOPWORDS = frozenset(
    (
        "а и в во на у с к ли же ну то нибудь он она они вы вас вам там тут это где что как кто "
        "есть какой какая какое какие каком какими каких"
    ).split()
)
_SUFFIXES = sorted(
    (
        "иями ями ами ого его ому ему ыми ими ией ией ать ять ить еть уть ешь ете ите ишь ает яет "
        "ует лись лось лась ись ось ась ится ется ая яя ое ее ые ие ый ий ой ей ую юю ом ем ам ям "
        "ах ях ов ев ий ия ие ья ье ью ть ла ло ли л а я о е ы и у ю ь й"
    ).split(),
    key=len,
    reverse=True,
)
_MIN_STEM = 3


def _stem(word: str) -> str:
    for suffix in _SUFFIXES:
        if word.endswith(suffix) and len(word) - len(suffix) >= _MIN_STEM:
            return word[: -len(suffix)]
    return word


def normalize(text: str) -> list[str]:
    """Строчные, ё→е, без знаков, без служебных слов, грубая основа слова."""
    words = re.findall(r"[a-zа-я0-9]+", text.lower().replace("ё", "е"))
    return [_stem(word) for word in words if word not in _STOPWORDS]


def _synonym_stems(synonym: str) -> list[str]:
    stems = normalize(synonym)
    if stems:
        return stems
    # Синоним только из служебных слов — сравниваем его целиком.
    return re.findall(r"[a-zа-я0-9]+", synonym.lower().replace("ё", "е"))


def _stem_in(stem: str, stems: set[str]) -> bool:
    if stem in stems:
        return True
    return len(stem) >= _MIN_STEM and any(
        len(s) >= _MIN_STEM and (s.startswith(stem) or stem.startswith(s)) for s in stems
    )


def _synonym_found(text_stems: set[str], synonym: str) -> bool:
    stems = _synonym_stems(synonym)
    return bool(stems) and all(_stem_in(s, text_stems) for s in stems)


def _match_score(text_stems: set[str], question: dict[str, Any]) -> int:
    """Длина самого полного совпавшего синонима (все его основы есть в тексте), иначе 0."""
    best = 0
    for synonym in question["synonyms"]:
        if _synonym_found(text_stems, synonym):
            best = max(best, len(_synonym_stems(synonym)))
    return best


# Поиск фактов в описании (оценка, contracts/operator/evaluation.md) — мягче, чем вопросов
# карты: обучаемый пишет своими словами, с цифрами и опечатками. Местоимения не мешают
# отрицанию стоять рядом со словом: «огня я не вижу».
_FACT_STOPWORDS = _STOPWORDS | frozenset(
    "я мы ты мне меня мной нас нам его ее ей им их него нее ним ней них ему".split()
)
# Числа словами — цифрами: «между четвёртым и пятым» = «между 4 и 5». «Один» не трогаем —
# чаще это «один в лифте», а не число.
_NUMBER_WORDS = tuple(
    (re.compile(pattern), digit)
    for pattern, digit in (
        (r"перв\w*", "1"),
        (r"втор\w*|два|две|двух|двум|двумя", "2"),
        (r"трет\w*|три|трех|трем|тремя", "3"),
        (r"четверт\w*|четыре|четырех|четырем|четырьмя", "4"),
        (r"пят(ь|и|ью|ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)", "5"),
        (r"шест(ь|и|ью|ой|ого|ому|ым|ом|ая|ую|ое|ые|ых|ыми)", "6"),
        (r"седьм\w*|семь|семи", "7"),
        (r"восьм\w*|восемь", "8"),
        (r"девят(ь|и|ью|ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)", "9"),
        (r"десят(ь|и|ью|ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)", "10"),
        (r"двадцат\w*", "20"),
    )
)
# Отрицание перед словом («не пострадал», «без света», «нет связи») и после («огня нет»).
_NOT = "не"
_ABSENT = frozenset({"нет", "без"})
_NEGATIONS = _ABSENT | {_NOT}
# Опечатка (одна буква) прощается в словах от пяти букв: «несовершенолетний», «ребёнка».
_TYPO_MIN = 5
# Граница фраз: отрицание действует только внутри своей фразы.
_CLAUSE_BREAK = re.compile(r"[,.;:!?()\n—–]")
_BREAK = "|"


def _fact_word(word: str) -> str:
    for pattern, digit in _NUMBER_WORDS:
        if pattern.fullmatch(word):
            return digit
    return _stem(word)


def _fact_tokens(text: str) -> list[str]:
    """Основы слов по порядку (отрицанию важно соседство), числа словами — цифрами. Между
    фразами — граница: «связи нет, погас свет» — «нет» не относится к «погас»."""
    tokens: list[str] = []
    for clause in _CLAUSE_BREAK.split(text.lower().replace("ё", "е")):
        words = re.findall(r"[a-zа-я0-9]+", clause)
        stems = [_fact_word(word) for word in words if word not in _FACT_STOPWORDS]
        if stems and tokens:
            tokens.append(_BREAK)
        tokens.extend(stems)
    return tokens


def _one_typo(a: str, b: str) -> bool:
    """Слова отличаются одной буквой: замена, пропуск, лишняя или переставлены соседние."""
    if len(a) > len(b):
        a, b = b, a
    if len(b) - len(a) > 1:
        return False
    i = 0
    while i < len(a) and a[i] == b[i]:
        i += 1
    if len(a) < len(b):
        return a[i:] == b[i + 1 :]
    return a[i + 1 :] == b[i + 1 :] or (
        a[i : i + 2] == b[i : i + 2][::-1] and a[i + 2 :] == b[i + 2 :]
    )


def _same_word(a: str, b: str) -> bool:
    if a == b:
        return True
    if min(len(a), len(b)) < _MIN_STEM:
        return False
    return (
        a.startswith(b) or b.startswith(a) or (min(len(a), len(b)) >= _TYPO_MIN and _one_typo(a, b))
    )


def _negated(tokens: list[str], i: int) -> bool:
    """Слово описания под отрицанием: «не дышит», «без сознания», «огня нет»."""
    before = i > 0 and tokens[i - 1] in _NEGATIONS
    after = i + 1 < len(tokens) and tokens[i + 1] == "нет"
    return before or after


def _negation_found(tokens: list[str], negation: str, word: str, after: bool) -> bool:
    """Отрицание рядом со словом: «не отвечает», «без света» = «нет света» = «света нет»;
    `after` — синоним ставит «не» после слова: «огня не (видно)»."""
    for i, token in enumerate(tokens):
        if not _same_word(token, word):
            continue
        prev = tokens[i - 1] if i > 0 else ""
        nxt = tokens[i + 1] if i + 1 < len(tokens) else ""
        if negation == _NOT and (nxt == _NOT if after else prev == _NOT):
            return True
        if negation in _ABSENT and (prev in _ABSENT or nxt == "нет"):
            return True
    return False


def _fact_synonym_found(tokens: list[str], synonym: str) -> bool:
    words = [word for word in _fact_tokens(synonym) if word != _BREAK] or _synonym_stems(synonym)
    i = 0
    while i < len(words):
        word = words[i]
        nxt = words[i + 1] if i + 1 < len(words) else None
        if word in _NEGATIONS and nxt is not None and nxt not in _NEGATIONS:
            if not _negation_found(tokens, word, nxt, after=False):
                return False
            i += 2
        elif nxt in _NEGATIONS and i + 2 == len(words):
            if not _negation_found(tokens, nxt, word, after=True):
                return False
            i += 2
        else:
            # Утверждение под отрицанием не засчитывается: «без сознания» — не «в сознании».
            found = any(
                _same_word(token, word) and (word in _NEGATIONS or not _negated(tokens, j))
                for j, token in enumerate(tokens)
            )
            if not found:
                return False
            i += 1
    return bool(words)


def mentions(text: str, synonyms: Iterable[str]) -> bool:
    """Есть ли в тексте хотя бы один синоним факта: все его слова с точностью до окончания
    (одна опечатка в длинном слове прощается), числа словами и цифрами равны, отрицание
    стоит рядом со своим словом («не пострадал»), а утверждение не отрицается («без
    сознания» — не «в сознании»). Оценка ищет так факты сценария в описании обучаемого."""
    tokens = _fact_tokens(text)
    return any(_fact_synonym_found(tokens, synonym) for synonym in synonyms)


def match_question(text: str, questionnaire: dict[str, Any]) -> str | None:
    """Ключ вопроса карты по свободному тексту; при равенстве — раньше в карте."""
    text_stems = set(normalize(text))
    if not text_stems:
        return None
    best_key, best_score = None, 0
    for question in questionnaire["questions"]:
        score = _match_score(text_stems, question)
        if score > best_score:
            best_key, best_score = question["key"], score
    return best_key


def _matches_other_card(text: str, own_id: str) -> bool:
    return any(
        match_question(text, card) is not None
        for card_id, card in load_questionnaires().items()
        if card_id != own_id
    )


@dataclass(frozen=True)
class CallerState:
    panic: int = PANIC_START
    # Вопросы карты, которые заявитель услышал (ответил спокойно или в панике).
    asked: tuple[str, ...] = ()
    # Вопросы карты со спокойным ответом — факт получен.
    facts: tuple[str, ...] = ()
    # Паузы оператора, после которых заявитель переспрашивал «Алло?».
    pauses: int = 0
    # Первый переспрос после действия — запас времени на заполнение карточки.
    silence_streak: int = 0
    # Вопросы и просьбы, не услышанные в истерике.
    unheard: int = 0
    calm_reason: int = 0
    calm_order: int = 0
    escalated: bool = False
    # После ухудшения дан совет, который на него отвечает (escalation.advice).
    escalation_handled: bool = False
    advice: tuple[str, ...] = ()
    # Этап 3: адрес подтверждён повтором — заявитель согласился с адресом карточки.
    confirmed: bool = False


def start_state(scenario: dict[str, Any]) -> CallerState:
    """Состояние в начале звонка: паника персонажа из сценария (start_panic)."""
    return CallerState(panic=scenario.get("start_panic", PANIC_START))


@dataclass(frozen=True)
class CallerReply:
    outcome: Outcome
    text: str
    panic: int
    question_key: str | None = None
    variant: Literal["calm", "panic"] | None = None
    # Ключ реплики в voice_lines(): по нему звучит голосовой файл заявителя.
    line: str | None = None


REACTION_LINES = ("calming", "calmed", "order", "repeat", "not_understood", "irrelevant", "hold")
# Ответы на повтор адреса (scenario.address_confirmation), в порядке озвучки.
CONFIRM_LINES = ("ok", "wrong_street", "wrong_details", "empty", "panic")


def voice_lines(scenario: dict[str, Any]) -> dict[str, str]:
    """Все реплики заявителя, которые может вернуть `act`: ключ голосового файла → текст.

    Ту же раскладку строит scripts/voices/operator_texts.py для озвучки; совпадение ключей и
    текстов с озвученными файлами проверяет test_voice_lines_are_voiced_with_current_texts.
    """
    lines: dict[str, str] = {}
    if scenario.get("opening"):
        lines["opening"] = scenario["opening"]
    for key, answer in scenario["answers"].items():
        lines[f"{key}.calm"] = answer["calm"]
        lines[f"{key}.panic"] = answer["panic"]
    confirmation = scenario.get("address_confirmation")
    if confirmation:
        for name in CONFIRM_LINES:
            lines[f"confirm.{name}"] = confirmation[name]
    for item in scenario.get("distractors", []):
        lines[f"distractor.{item['key']}"] = item["reply"]
    reactions = scenario.get("reactions")
    if reactions:
        for index, text in enumerate(reactions["hysteria"]):
            lines[f"hysteria.{index}"] = text
        for name in REACTION_LINES:
            lines[name] = reactions[name]
        for index, text in enumerate(reactions["pause"]):
            lines[f"pause.{index}"] = text
    for item in scenario.get("advice", []):
        lines[f"advice.{item['key']}"] = item["reply"]
    escalation = scenario.get("escalation")
    if escalation:
        lines["escalation"] = escalation["text"]
    return lines


def _clamp(level: int) -> int:
    return max(PANIC_MIN, min(PANIC_MAX, level))


def _unheard(
    scenario: dict[str, Any], state: CallerState, key: str | None = None
) -> tuple[CallerState, CallerReply]:
    """В истерике заявитель кричит своё и не слышит оператора; вопрос не считается заданным."""
    lines = scenario["reactions"]["hysteria"]
    index = state.unheard % len(lines)
    reply = CallerReply("unheard", lines[index], state.panic, key, line=f"hysteria.{index}")
    return replace(state, unheard=state.unheard + 1), reply


def question_steps(questionnaire: dict[str, Any]) -> dict[str, int]:
    """Ключ вопроса карты → его шаг опроса (1–5)."""
    return {question["key"]: question["step"] for question in questionnaire["questions"]}


# Тип улицы в свободном вводе: полное слово и сокращения — одно и то же. evalcore убирает только
# «ул»/«улица», поэтому «Профсоюзная» совпадала с «Профсоюзная улица», а «Кутузовский» и
# «Кутузовский пр-т» с «Кутузовский проспект» — нет (критическая ошибка адреса).
_STREET_KINDS = tuple(
    (re.compile(pattern), kind)
    for pattern, kind in (
        (r"ул|улица", "улица"),
        (r"пр|пр-?к?т|просп|проспект", "проспект"),
        (r"пр-?з?д|проезд", "проезд"),
        (r"пер|переулок", "переулок"),
        (r"ш|шоссе", "шоссе"),
        (r"б-?р|бул|бульвар", "бульвар"),
        (r"пл|площадь", "площадь"),
        (r"наб|набережная", "набережная"),
        (r"туп|тупик", "тупик"),
    )
)
# «к2», «д. 8», «кв58» — номер с приклеенным обозначением поля.
_NUMBER_PREFIX = re.compile(r"^(?:д|дом|к|корп|корпус|кв|квартира)\.?\s*(?=\d)")


def _street_parts(value: str) -> tuple[str, str | None]:
    """Название улицы без типа и тип, если он написан."""
    names: list[str] = []
    kinds: list[str] = []
    for token in re.split(r"[\s.,]+", value.casefold().replace("ё", "е")):
        kind = next((kind for pattern, kind in _STREET_KINDS if pattern.fullmatch(token)), None)
        if kind:
            kinds.append(kind)
        elif token:
            names.append(token)
    return " ".join(names), kinds[0] if kinds else None


def address_field_match(field: str, expected: str, actual: str) -> bool:
    """Поле адреса карточки совпадает с адресом сценария — для оценки и повтора адреса.

    Сравнение точное (evalcore.address: «Дубининская» ≠ «Дубнинская»), но тип улицы можно не
    писать или писать сокращённо; написанный тип должен совпасть: «Кутузовский» и
    «Кутузовский пр-т» = «Кутузовский проспект», «Кутузовский переулок» — нет.
    """
    if field == "street":
        name, kind = _street_parts(actual)
        expected_name, expected_kind = _street_parts(expected)
        return address_components_match("street", expected_name, name) and kind in (
            None,
            expected_kind,
        )
    if field in CONFIRM_DETAILS:
        actual = _NUMBER_PREFIX.sub("", actual.strip().casefold())
    return bool(address_components_match(field, expected, actual))


def address_mismatch(
    scenario: dict[str, Any], address: Mapping[str, str]
) -> Literal["empty", "street", "details"] | None:
    """Что заявитель услышит неверным в повторе адреса из карточки; None — всё сходится.

    Улица сравнивается всегда (ловушка «Дубининская»), дом, корпус и квартира — если они есть в
    адресе сценария; сравнение — как в оценке адреса (`address_field_match`).
    """
    expected = scenario["address"]
    street = address.get("street", "")
    if not street.strip():
        return "empty"
    if not address_field_match("street", expected["street"], street):
        return "street"
    for field in CONFIRM_DETAILS:
        if expected.get(field) and not address_field_match(
            field, expected[field], address.get(field, "")
        ):
            return "details"
    return None


def _confirm(
    scenario: dict[str, Any], state: CallerState, address: Mapping[str, str]
) -> tuple[CallerState, CallerReply]:
    """Повтор адреса вслух: заявитель сверяет адрес карточки с тем, что знает сам.

    В панике «да» ненадёжно — адрес не подтверждён; совпало — паника −1 и `confirmed`; не
    совпало — заявитель поправляет, и повтор можно сделать снова после исправления карточки.
    """
    lines = scenario["address_confirmation"]
    if state.panic >= PANIC_HYSTERIA:
        return _unheard(scenario, state, CONFIRM_KEY)
    mismatch = address_mismatch(scenario, address)
    if mismatch == "empty":
        reply = CallerReply(
            "unconfirmed", lines["empty"], state.panic, CONFIRM_KEY, line="confirm.empty"
        )
        return state, reply
    if state.panic >= PANIC_THRESHOLD:
        reply = CallerReply(
            "unconfirmed", lines["panic"], state.panic, CONFIRM_KEY, line="confirm.panic"
        )
        return state, reply
    if mismatch is not None:
        name = "wrong_street" if mismatch == "street" else "wrong_details"
        reply = CallerReply(
            "corrected", lines[name], state.panic, CONFIRM_KEY, line=f"confirm.{name}"
        )
        return state, reply
    panic = _clamp(state.panic - 1)
    reply = CallerReply("confirmed", lines["ok"], panic, CONFIRM_KEY, line="confirm.ok")
    return replace(state, panic=panic, confirmed=True), reply


def _distractor(
    scenario: dict[str, Any], state: CallerState, key: str
) -> tuple[CallerState, CallerReply]:
    """Лишний вопрос шага: правдоподобный, но не по делу — заявитель злится, паника +1."""
    items = {item["key"]: item for item in scenario.get("distractors", [])}
    if key not in items:
        raise ValueError(f"Лишнего вопроса {key} нет в сценарии {scenario['id']}")
    if state.panic >= PANIC_HYSTERIA:
        return _unheard(scenario, state, key)
    panic = _clamp(state.panic + 1)
    reply = CallerReply("irrelevant", items[key]["reply"], panic, key, line=f"distractor.{key}")
    return replace(state, panic=panic), reply


def _question(
    scenario: dict[str, Any],
    state: CallerState,
    text: str | None,
    key: str | None,
    address: Mapping[str, str],
) -> tuple[CallerState, CallerReply]:
    questionnaire_id = scenario["questionnaire_id"]
    questionnaire = load_questionnaires()[questionnaire_id]
    steps = question_steps(questionnaire)
    if key is not None and key not in steps:
        raise ValueError(f"Вопроса {key} нет в опросной карте {questionnaire_id}")
    if key is None:
        key = match_question(text or "", questionnaire)
    if key == CONFIRM_KEY:
        return _confirm(scenario, state, address)
    reactions = scenario["reactions"]
    if state.panic >= PANIC_HYSTERIA:
        return _unheard(scenario, state, key)

    if key is None:
        irrelevant = bool(text) and _matches_other_card(text or "", questionnaire_id)
        name: Literal["irrelevant", "not_understood"] = (
            "irrelevant" if irrelevant else "not_understood"
        )
        panic = _clamp(state.panic + 1)
        return replace(state, panic=panic), CallerReply(name, reactions[name], panic, line=name)

    if key in state.facts:
        # Спокойный ответ уже был — «Я же уже сказала!». После панического ответа
        # переспрос уточняет факт и не наказывается (замечание капитана 29.09).
        panic = _clamp(state.panic + 1)
        reply = CallerReply("repeated", reactions["repeat"], panic, key, line="repeat")
        return replace(state, panic=panic), reply
    # Этап 3: без адреса помощь не отправить — вопрос следующих шагов раньше адреса заявитель
    # слышит как потерю времени (APCO/NENA: адрес первым). Шаг 1 — в любое время.
    early = steps[key] > ADDRESS_STEP and ADDRESS_KEY not in state.asked
    outcome: Outcome = "early" if early else "correct"
    # Заявитель отвечает в том состоянии, в каком его спросили; сам вопрос меняет панику
    # уже после ответа — поэтому на пороге звучит панический вариант (ловушка адреса).
    variant: Literal["calm", "panic"] = "panic" if state.panic >= PANIC_THRESHOLD else "calm"
    panic = _clamp(state.panic + (1 if early else -1))
    facts = state.facts if variant == "panic" else (*state.facts, key)
    asked = state.asked if key in state.asked else (*state.asked, key)
    reply = CallerReply(
        outcome, scenario["answers"][key][variant], panic, key, variant, line=f"{key}.{variant}"
    )
    return replace(state, panic=panic, asked=asked, facts=facts), reply


def _calm(
    scenario: dict[str, Any], state: CallerState, kind: str
) -> tuple[CallerState, CallerReply]:
    reactions = scenario["reactions"]
    if kind == "order":
        # «Успокойтесь!» без причины злит; в истерике хуже уже некуда.
        panic = state.panic if state.panic >= PANIC_HYSTERIA else _clamp(state.panic + 1)
        reply = CallerReply("order", reactions["order"], panic, line="order")
        return replace(state, panic=panic, calm_order=state.calm_order + 1), reply
    if kind == "soft":
        if state.panic >= PANIC_HYSTERIA:
            return _unheard(scenario, state)
        panic = _clamp(state.panic - 1)
        reply = CallerReply("calmed", reactions["calmed"], panic, line="calmed")
        return replace(state, panic=panic), reply

    state = replace(state, calm_reason=state.calm_reason + 1)
    if state.panic >= PANIC_HYSTERIA:
        panic = PANIC_HYSTERIA - 1
        reply = CallerReply("calming", reactions["calming"], panic, line="calming")
        return replace(state, panic=panic), reply
    if state.panic >= PANIC_THRESHOLD:
        panic = state.panic - 1
        # Просьба с причиной просила адрес: ниже порога заявитель его и называет.
        if "address" in scenario["answers"] and "address" not in state.facts:
            asked = state.asked if "address" in state.asked else (*state.asked, "address")
            reply = CallerReply(
                "calmed",
                scenario["answers"]["address"]["calm"],
                panic,
                "address",
                "calm",
                line="address.calm",
            )
            facts = (*state.facts, "address")
            return replace(state, panic=panic, asked=asked, facts=facts), reply
        reply = CallerReply("calmed", reactions["calmed"], panic, line="calmed")
        return replace(state, panic=panic), reply
    return state, CallerReply("calmed", reactions["calmed"], state.panic, line="calmed")


def _advice(
    scenario: dict[str, Any], state: CallerState, key: str
) -> tuple[CallerState, CallerReply]:
    items = {item["key"]: item for item in scenario.get("advice", [])}
    if key not in items:
        raise ValueError(f"Совета {key} нет в сценарии {scenario['id']}")
    if state.panic >= PANIC_HYSTERIA:
        return _unheard(scenario, state)
    escalation = scenario.get("escalation")
    handled = state.escalation_handled or (
        state.escalated and escalation is not None and escalation["advice"] == key
    )
    advice = state.advice if key in state.advice else (*state.advice, key)
    panic = _clamp(state.panic - 1)
    reply = CallerReply("advice", items[key]["reply"], panic, line=f"advice.{key}")
    return replace(state, panic=panic, advice=advice, escalation_handled=handled), reply


def act(
    scenario: dict[str, Any],
    state: CallerState,
    action: str = "question",
    *,
    text: str | None = None,
    key: str | None = None,
    kind: str | None = None,
    distractor: str | None = None,
    address: Mapping[str, str] | None = None,
) -> tuple[CallerState, CallerReply]:
    """Одно действие оператора → новое состояние заявителя и его реплика.

    question — вопрос словами (`text`), вопрос карты (`key`) или лишний вопрос шага
    (`distractor`); на повтор адреса заявитель отвечает по адресу карточки (`address`);
    calm — «Успокоить» (`kind`: reason, soft, order); hold — «Я вас слышу, записываю»;
    silence — оператор молчит дольше паузы; advice — совет (`kind` — его ключ); escalate —
    ситуация ухудшается по сценарию. Время считает веб: silence и escalate он присылает сам.
    """
    # Автоматическое ухудшение не означает, что оператор восстановил контакт.
    if action in ("question", "calm", "hold", "advice"):
        state = replace(state, silence_streak=0)
    if scenario["questionnaire_id"] is None:
        return state, CallerReply("no_incident", REPLY_WRONG_CALL, state.panic)
    if action == "question":
        if distractor is not None:
            return _distractor(scenario, state, distractor)
        return _question(scenario, state, text, key, address or {})
    if action == "calm":
        if kind not in CALM_KINDS:
            raise ValueError(f"Неизвестный приём «Успокоить»: {kind}")
        return _calm(scenario, state, kind)
    if action == "hold":
        if state.panic >= PANIC_HYSTERIA:
            return _unheard(scenario, state)
        reply = CallerReply("hold", scenario["reactions"]["hold"], state.panic, line="hold")
        return state, reply
    if action == "silence":
        lines = scenario["reactions"]["pause"]
        index = min(state.pauses, len(lines) - 1)
        panic = _clamp(state.panic + (1 if state.silence_streak >= 1 else 0))
        reply = CallerReply("silence", lines[index], panic, line=f"pause.{index}")
        return replace(
            state, panic=panic, pauses=state.pauses + 1, silence_streak=state.silence_streak + 1
        ), reply
    if action == "advice":
        if not kind:
            raise ValueError("Для совета нужен его ключ")
        return _advice(scenario, state, kind)
    if action == "escalate":
        escalation = scenario.get("escalation")
        if escalation is None or state.escalated:
            return state, CallerReply("noop", "", state.panic)
        panic = _clamp(max(state.panic + 1, PANIC_THRESHOLD))
        reply = CallerReply("escalation", escalation["text"], panic, line="escalation")
        return replace(state, panic=panic, escalated=True), reply
    raise ValueError(f"Неизвестное действие оператора: {action}")


def ask(
    scenario: dict[str, Any],
    state: CallerState,
    text: str | None = None,
    key: str | None = None,
    address: Mapping[str, str] | None = None,
) -> tuple[CallerState, CallerReply]:
    """Один вопрос оператора: свободным текстом (`text`) или вопросом карты (`key`)."""
    return act(scenario, state, "question", text=text, key=key, address=address)


@dataclass(frozen=True)
class StepProgress:
    """Ход опроса по шагам: текущий шаг (первый не пройденный) и пройденные."""

    step: int
    done: tuple[int, ...]


def step_done(questionnaire: dict[str, Any], state: CallerState, step: int) -> bool:
    """Шаг пройден, когда заявитель услышал все вопросы карты этого шага; повтор адреса —
    когда адрес подтверждён. Лишние вопросы шаг не проходят."""
    keys = [key for key, value in question_steps(questionnaire).items() if value == step]
    return all(state.confirmed if key == CONFIRM_KEY else key in state.asked for key in keys)


def step_progress(scenario: dict[str, Any], state: CallerState) -> StepProgress:
    """Шаги опроса для экрана (вкладки, проводник) и журнала звонка."""
    if scenario["questionnaire_id"] is None:
        return StepProgress(STEPS[0], ())
    questionnaire = load_questionnaires()[scenario["questionnaire_id"]]
    done = tuple(step for step in STEPS if step_done(questionnaire, state, step))
    current = next((step for step in STEPS if step not in done), STEPS[-1])
    return StepProgress(current, done)
