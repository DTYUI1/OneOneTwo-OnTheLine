"""Вводная бригаде (GP-05): фраза диспетчера → адрес, который поняла бригада, и повод.

Бригада выезжает только после вводной: диспетчер звонит ей и говорит адрес и что
случилось — голосом или собрав фразу по частям (`docs/dds_gameplay.md`, разделы 3 и 4).
Голос и части проверяются одним правилом: части склеиваются в ту же фразу.

- **Адрес** (`address`): `ok` — прозвучали все слова названия улицы эталона (звание
  «Академика» можно опустить: «Янгеля, 6»; та же основа
  в любом падеже, без исправления опечаток), её тип («бульвар», а не «переулок»; «улицу»
  можно не говорить, если другой тип не назван) и номер дома там, где говорят дом
  (`comment.house_said`: «квартира 24, дом 7» — не дом 24) — как поправка адреса в ответе
  бригаде (`voice_reply`). `wrong` — названа другая улица (другое название или другой тип
  рядом с названием, похожее слово «Дубининская» при «Дубнинская») или та же улица с другим
  номером дома: бригада едет туда, что услышала.
  `missing` — адреса нет или нет номера дома: бригада переспрашивает.
- **Повод**: `incident` — соответствие эталону (`report.reason_said`, правило доклада
  службе не меняется). `incident_said` — названо понятное происшествие, в том числе другое:
  пожар, газ, драка, человеку плохо, затопление, застрявший лифт, ДТП и устные аналоги.
  Отрицания, метаречь и слова в названии улицы не становятся поводом. В накопительной
  фразе последнее утвердительное сообщение о происшествии определяет соответствие
  эталону; явная поправка повода не стирает ранее названный адрес.

Запинки («э-э», «ну») убираются до сравнения (`report.plain_speech`).

Вводная полная (`complete`), если адрес назван (верно или нет) и повод прозвучал.
Эталон адреса — `reference.expected_address`, без него — адрес карточки.
"""

import re
from dataclasses import dataclass

from evalcore.address import _same_word, other_street, spoken_street_words
from evalcore.comment import CommentKeywordsCriterion, _clean, house_said
from evalcore.models import Json, TextChecker
from evalcore.report import plain_speech, reason_said, report_facts, spoken_numbers, unglued
from evalcore.voice_reply import _ADDRESS, _STREET_TYPE, _Spoken, _spoken
from evalcore.voice_reply import spoken_numbers as reply_numbers

ADDRESS_OK = "ok"
ADDRESS_WRONG = "wrong"
ADDRESS_MISSING = "missing"


@dataclass(frozen=True)
class Briefing:
    """Что бригада поняла из вводной."""

    address: str
    # Адрес, как его поняла бригада: эталон при `ok`, сказанное при `wrong`, иначе None.
    heard_address: str | None
    incident: bool
    incident_said: bool = False

    @property
    def complete(self) -> bool:
        return self.address != ADDRESS_MISSING and (self.incident or self.incident_said)


# Названный корпус: «корпус 3», «к. 3», «строение 3» (`comment.house_said` его сверяет).
_OTHER_BUILDING = re.compile(r"(?<![а-я])(?:корпус[а-я]*|корп|к|строени[а-я]*|стр)\.?\s*(\d+)")


def _expected(scenario: dict[str, Json]) -> Json:
    reference = scenario.get("reference")
    card = scenario.get("card")
    return (reference.get("expected_address") if isinstance(reference, dict) else None) or (
        card.get("address") if isinstance(card, dict) else None
    )


def expected_building(scenario: dict[str, Json]) -> str:
    """Корпус дома эталона (`building`); пусто — корпуса нет."""
    address = _expected(scenario)
    building = address.get("building") if isinstance(address, dict) else None
    return building.strip() if isinstance(building, str) else ""


def expected_address(scenario: dict[str, Json]) -> tuple[str, str]:
    """Улица и дом эталона: `reference.expected_address`, без него — адрес карточки."""
    address = _expected(scenario)
    if not isinstance(address, dict):
        return "", ""
    street, house = address.get("street"), address.get("house")
    return (
        street.strip() if isinstance(street, str) else "",
        house.strip() if isinstance(house, str) else "",
    )


def _street_type(street: str) -> str:
    """Тип улицы эталона полным словом; пусто — тип в названии не указан."""
    for word in re.findall(r"[А-Яа-яЁё-]+", street):
        found = _STREET_TYPE.get(_clean(word).rstrip("."))
        if found:
            return found
    return ""


def _type_said(street_type: str, spoken: _Spoken) -> bool:
    return any(
        _STREET_TYPE.get(word) == street_type or _same_word(street_type, word)
        for word in spoken.words
    )


def _join(street: str, house: str) -> str:
    return f"{street}, {house}" if house else street


def _address(scenario: dict[str, Json], text: str, checker: TextChecker) -> tuple[str, str | None]:
    street, house = expected_address(scenario)
    names = spoken_street_words(street)
    if not names:
        return ADDRESS_MISSING, None
    spoken = _spoken(text, checker)
    street_type = _street_type(street)
    same_name = all(any(_same_word(name, word) for word in spoken.words) for name in names)
    # «Улица» в речи подразумевается: «Люблинская, сто» — это Люблинская улица (проверка 17.10:
    # бригада трижды переспрашивала адрес без слова «улица»). Бульвар, переулок, шоссе и
    # остальные типы называют: у них в Москве часто есть тёзки другого типа.
    types_said = {_STREET_TYPE[word] for word in spoken.words if word in _STREET_TYPE}
    same_type = (
        not street_type
        or _type_said(street_type, spoken)
        or (street_type == "улица" and not types_said)
    )
    house_clean = _clean(house)
    # Номер дома — там, где говорят дом (`comment.house_said`): «квартира 24 дом 7» — дом 7.
    if (
        same_name
        and same_type
        and (not house_clean or house_said(spoken.text, house, names, expected_building(scenario)))
    ):
        return ADDRESS_OK, _join(street, house)
    if same_name and same_type and house_clean and house_said(spoken.text, house, names):
        # Дом тот, корпус другой: «Профсоюзная 98 корпус 3» при корпусе 2.
        named = _OTHER_BUILDING.search(_clean(spoken.text))
        building = f" корпус {named.group(1)}" if named else ""
        return ADDRESS_WRONG, _join(street, house + building)
    said = reply_numbers(text, checker)
    for pattern in _ADDRESS:
        match = pattern.search(said)
        if match is None:
            continue
        name, kind, number = match.group("name"), match.group("type"), match.group("house") or ""
        this_street = any(_same_word(_clean(name), word) for word in names) and (
            not street_type or _STREET_TYPE.get(_clean(kind).rstrip(".")) == street_type
        )
        if this_street and (not number or _clean(number) == house_clean):
            # Та же улица без номера дома: бригада переспросит.
            return ADDRESS_MISSING, None
        heard = f"{name} {_clean(kind)}" if match.re is _ADDRESS[0] else f"{_clean(kind)} {name}"
        return ADDRESS_WRONG, _join(heard, number)
    other = other_street(text, street)
    if other is not None:
        return ADDRESS_WRONG, other
    if same_name and same_type:
        # Улица та, номер дома другой: «Бескудниковский бульвар, 42».
        numbers = sorted(spoken.numbers - {house_clean})
        if numbers:
            return ADDRESS_WRONG, _join(street, numbers[0])
    return ADDRESS_MISSING, None


def _incident(scenario: dict[str, Json], text: str, checker: TextChecker) -> bool:
    spoken = unglued(spoken_numbers(text, checker), report_facts(scenario, checker))
    lemmas = CommentKeywordsCriterion._comment_lemmas(checker, spoken)
    return reason_said(scenario, spoken, checker, lemmas)


# Наличие происшествия не зависит от эталона карточки: это сведения бригады,
# а не оценка их истинности. Покрывает варианты частей и их устные пересказы.
_INCIDENT_WORDS = re.compile(
    r"\b(?:пожар(?:а|у|ом|е|ы|ов)?|задымлен\w*|дым(?:а|у|ом|е)?|горит|горят|загорел\w*|возгорани\w*|"
    r"драк\w*|дерутся|дтп|авари\w*|столкнул\w*|затоплен\w*|заливает|"
    r"прорвало\s+труб\w*|(?:запах\w*|пахнет|утечк\w*)\s+газ\w*|"
    r"(?:человек\w*|мужчин\w*|женщин\w*|ребен\w*)\s+(?:плохо|не\s+дыш\w*)|"
    r"лифт\w*\s+не\s+работа\w*|"
    r"потерял\w*\s+сознани\w*|без\s+сознания|"
    r"застрял\w*\s+(?:\w+\s+){0,2}лифт\w*)\b"
)
# Отрицается само событие («пожара нет», «не горит»), а не любое условие
# в предложении («запах не уходит», «ребенок без взрослых», «не закрываются двери»).
_EVENT_HEAD = (
    r"(?:пожар\w*|драк\w*|дтп|авари\w*|задымлен\w*|дым\w*|возгорани\w*|"
    r"горит|горят|загорел\w*|дерутся|столкнул\w*|затоплен\w*|заливает|"
    r"прорвало|запах\w*(?:\s+газ\w*)?|утечк\w*(?:\s+газ\w*)?|газ\w*|"
    r"пахнет|плохо|потерял\w*|застрял\w*|застревани\w*)"
)
_NEGATED = re.compile(
    r"\b(?:не|нет|без|никак\w*|отсутств\w*)\s+(?:было\s+)?" + _EVENT_HEAD + r"\b|"
    r"\bне\s+(?:чувству\w*|ощуща\w*|наблюда\w*)\s+" + _EVENT_HEAD + r"\b|"
    r"\b"
    + _EVENT_HEAD
    + r"(?:\s+(?:здесь|тут|там|уже|больше)){0,2}\s+(?:нет|не\s+было|отсутств\w*)\b"
)
_META = re.compile(r"\b(?:како[йея]|выбрать|повторите|скажите|слово|обсуждаем|спасибо|слышите)\b")
# Вопрос «какой, пожар?» сохраняет область действия до деления по запятым.
_META_QUESTION = re.compile(r"^\s*(?:како[йея]\b|вы\s+сказали\b)")
_CORRECTION = re.compile(r"\b(?:нет\s+это\s+|(?:поправка|точнее|исправляю)\b\s*:?)")


def _incident_clauses(scenario: dict[str, Json], text: str) -> list[tuple[str, bool]]:
    """Сообщения без адресов и метаречи, с признаком явной поправки.

    Адрес проверяется отдельно по полной фразе: уточнение повода не стирает улицу.
    «Без пострадавших» не отрицает само ДТП; отрицание в другом предложении не мешает.
    """
    for pattern in _ADDRESS:
        text = pattern.sub(" ", text)
    text = _clean(text)
    street, _ = expected_address(scenario)
    if street:
        text = re.sub(r"\b" + re.escape(_clean(street)) + r"\b", " ", text)
    clauses: list[tuple[str, bool]] = []
    correction = False
    for part in re.split("(" + _CORRECTION.pattern + ")", text):
        if _CORRECTION.fullmatch(part):
            correction = True
            continue
        for sentence in re.split(r"[.!?;]+", part):
            if _META_QUESTION.search(sentence):
                continue
            for clause in re.split(r",+|\b(?:но|а)\b", sentence):
                if clause.strip() and not _META.search(clause):
                    clauses.append((clause, correction))
                    correction = False
    return clauses


def briefing_check(scenario: dict[str, Json], text: str, checker: TextChecker) -> Briefing:
    """Что бригада поняла из вводной: адрес (`ok`/`wrong`/`missing`) и прозвучал ли повод."""
    text = plain_speech(text)
    if not text.strip():
        return Briefing(ADDRESS_MISSING, None, False)
    address, heard = _address(scenario, text, checker)
    incident = said = False
    for clause, correction in _incident_clauses(scenario, text):
        if _NEGATED.search(clause):
            # Отмена внутри этой вводной меняет состояние; отдельное отрицание
            # без поправки не отменяет ранее сообщённое происшествие.
            if correction:
                incident = said = False
            continue
        correct = _incident(scenario, clause, checker)
        if correct or _INCIDENT_WORDS.search(clause):
            incident, said = correct, True
    return Briefing(address, heard, incident, said)
