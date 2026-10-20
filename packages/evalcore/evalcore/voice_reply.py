"""Ответ бригаде голосом (DT-16): распознанная фраза → вариант ответа реплики бригады.

Бригада спрашивает (`ScenarioEvent.line` с `reply_options`): «На каком этаже?», «Как
поняли? Бескудниковский переулок, двадцать четыре». Диспетчер отвечает голосом, и фраза
сводится к одному из вариантов этой реплики — тому же `option_key`, что у кнопки: мир и
разбор считают голос и вариант одинаково, разница только в отметке «голосом».

Правило сопоставления (`voice_reply_option`), без ИИ и без исправления опечаток:

- Числа словами — цифрами, и в подписи, и во фразе: «Девятый этаж» → «9 этаж»,
  «двадцать четыре» → «24» (`spoken_numbers`, до 999, количественные и порядковые).
- **Вариант с адресом** — в подписи есть тип улицы и название рядом с ним («Поправка по
  адресу: Бескудниковский бульвар, 24»). Засчитывается, только если во фразе прозвучали все
  слова названия улицы (та же основа в любом падеже, как в адресе доклада: «Дубнинской» =
  «Дубнинская», но «Дубининская» ≠ «Дубнинская»), тот же тип улицы («бульвар», а не
  «переулок») и номер дома там, где говорят дом (`comment.house_said`: «квартира 24» — не
  дом 24). Остальные слова подписи («Поправка по адресу») — обрамление,
  их можно не говорить: «Каширское шоссе, двадцать шесть», «Нет, Каширское шоссе, дом 26»,
  «Адрес: …» — та же поправка (HQ-024). Корпус подписи («98, корпус 2») сверяется, если
  назван: «98 корпус 1» — другой дом; «98к2» и «98/2» — корпус 2.
- **Поправка повтора бригады** (`question` — реплика бригады с ошибочным повтором адреса,
  ловушка `readback_error`): фраза должна отличать верный адрес от повтора. Номер дома и
  название улицы подписи и так обязательны; если повтор ошибся только типом улицы или
  корпусом, нужен верный тип («шоссе», а не «Каширское 26» на «Каширский проезд, 26») или
  корпус («корпус 2» на «корпус один»). Тип, в котором повтор не ошибся, можно не говорить:
  «Мира, двадцать шесть» на «Проспект Мира, тридцать шесть». Без реплики — тип обязателен,
  кроме «улицы».
- **Остальные варианты** — значимые слова подписи (без предлогов и союзов, по начальной
  форме, как ключевые сведения комментария) и её числа. Вариант подходит, если прозвучали
  все его числа и не меньше половины (с округлением вверх) его слов и чисел вместе:
  «Девятый» отвечает на «Девятый этаж», «Уточню и перезвоню» — на «Уточню у заявителя и
  перезвоню».
- **Поля карточки в подписи** (`{caller_phone}`, `{caller_name}` подставлены загрузчиком,
  `app.seed.card_fields`) — одно необязательное слово подписи: в долю слов не входит, а
  прозвучав, решает само (как номер карточки). Телефон — по цифрам (`_phone_said`: числа
  словами — цифрами, разделители не важны, «8» в начале = «+7»; засчитывается совпадение
  последних 4–7 цифр), без номера хватает остальных слов («Телефон заявителя»); прозвучал
  другой номер — вариант не подходит. ФИО заявителя (`card.caller_name`) — по фамилии в
  любом падеже; чужая фамилия — не поле, решают остальные слова.
- Подошло несколько вариантов — выигрывает вариант с адресом (поправка сильнее «Понял»), иначе
  вариант с большей долей прозвучавших слов; равенство — фраза не сопоставлена, бригада
  переспрашивает. Не подошёл ни один — тоже переспрашивает.

[ASSUMPTION] Половины слов хватает: подписи вариантов короткие и различаются смыслом, а
нужные числа и адрес проверяются строго. Отрицание («не знаю») — обычное слово подписи.
"""

import math
import re
from collections.abc import Sequence
from dataclasses import dataclass

from evalcore.address import _same_word
from evalcore.comment import _STOP, _clean, house_said
from evalcore.models import Json, SpellingIssue, TextChecker

_TOKEN = re.compile(r"[А-Яа-яЁё]+(?:-[А-Яа-яЁё]+)*|\d+")
_WORD = re.compile(r"[А-Яа-яЁё]+")

# Тип улицы в подписи и во фразе: сокращение → полное слово. Тип различает улицы
# («Бескудниковский бульвар» и «Бескудниковский переулок» — обе есть в Москве).
_STREET_TYPE = {
    "улица": "улица",
    "ул": "улица",
    "проспект": "проспект",
    "пр-т": "проспект",
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
_TYPE_PATTERN = (
    "(?i:" + "|".join(re.escape(word) for word in sorted(_STREET_TYPE, key=len, reverse=True)) + ")"
)
_NAME = r"[А-ЯЁ][А-Яа-яЁё-]{2,}"
# Корпус после дома: «98, корпус 2», «98 к. 2».
_BUILDING_TAIL = r"(?:,?\s*(?i:корпус|корп|к)\.?\s*(?P<building>\d+))?"
# «Бескудниковский бульвар, 24», «улица Дубнинская, дом 1», «ул. Дубнинская 1».
_ADDRESS = (
    re.compile(
        rf"(?P<name>{_NAME})\s+(?P<type>{_TYPE_PATTERN})(?![А-Яа-яЁё])\.?,?\s*"
        rf"(?:(?i:дом|д)\.?\s*)?(?P<house>\d+[А-Яа-яЁё]?)?{_BUILDING_TAIL}",
    ),
    re.compile(
        rf"(?<![А-Яа-яЁё])(?P<type>{_TYPE_PATTERN})\.?\s+(?P<name>{_NAME})\.?,?\s*"
        rf"(?:(?i:дом|д)\.?\s*)?(?P<house>\d+[А-Яа-яЁё]?)?{_BUILDING_TAIL}",
    ),
)
# Повтор бригады без типа улицы: «Профсоюзная, восемьдесят девять, корпус два» (числа уже
# цифрами). Слово с заглавной перед номером дома.
_UNTYPED = re.compile(
    rf"(?P<name>{_NAME}),?\s+(?:(?i:дом|д)\.?\s*)?(?P<house>\d+[А-Яа-яЁё]?)(?!\d){_BUILDING_TAIL}"
)
# Корпус слитно с домом: «98к2», «98 к2», «98/2» → «98 корпус 2».
_JOINED_BUILDING = re.compile(r"(?<!\d)(\d+)\s*(?:[кК]\.?|/)\s*(\d+)(?!\d)")

# Числа словами: начальная форма → (значение, разряд). Разряд: 3 — сотни, 2 — десятки,
# 1 — единицы и 11…19. Порядковые — в той же таблице («девятый этаж» = «9 этаж»).
_UNITS = (
    ("ноль", "нулевой"),
    ("один одна одно", "первый"),
    ("два две", "второй"),
    ("три", "третий"),
    ("четыре", "четвертый"),
    ("пять", "пятый"),
    ("шесть", "шестой"),
    ("семь", "седьмой"),
    ("восемь", "восьмой"),
    ("девять", "девятый"),
    ("десять", "десятый"),
    ("одиннадцать", "одиннадцатый"),
    ("двенадцать", "двенадцатый"),
    ("тринадцать", "тринадцатый"),
    ("четырнадцать", "четырнадцатый"),
    ("пятнадцать", "пятнадцатый"),
    ("шестнадцать", "шестнадцатый"),
    ("семнадцать", "семнадцатый"),
    ("восемнадцать", "восемнадцатый"),
    ("девятнадцать", "девятнадцатый"),
)
_TENS = (
    ("двадцать", "двадцатый"),
    ("тридцать", "тридцатый"),
    ("сорок", "сороковой"),
    ("пятьдесят", "пятидесятый"),
    ("шестьдесят", "шестидесятый"),
    ("семьдесят", "семидесятый"),
    ("восемьдесят", "восьмидесятый"),
    ("девяносто", "девяностый"),
)
_HUNDREDS = "сто двести триста четыреста пятьсот шестьсот семьсот восемьсот девятьсот".split()
_NUMBER_WORDS: dict[str, tuple[int, int]] = {
    **{word: (value, 1) for value, forms in enumerate(_UNITS) for word in " ".join(forms).split()},
    **{
        word: (20 + 10 * index, 2)
        for index, forms in enumerate(_TENS)
        for word in " ".join(forms).split()
    },
    **{word: (100 * (index + 1), 3) for index, word in enumerate(_HUNDREDS)},
    "сотый": (100, 3),
}
# Порядковые в косвенных формах без словаря начальных форм: «девятом», «девятая».
_ORDINAL_ENDINGS = ("ого", "ому", "ом", "ая", "ое", "ой", "ую", "ые", "ых", "ым")
_ORDINALS = frozenset({forms[1] for forms in (*_UNITS, *_TENS)} | {"сотый"})
# Порядковое перед «дом» остаётся порядковым: «двадцать четвёртый дом» → «24-й дом», чтобы
# номер дома не путался с хвостом другого номера («квартира 24 дом 7», `comment.house_said`).
_HOUSE_AFTER = re.compile(r"\s+дом", re.I)


def _number_word(word: str, checker: TextChecker) -> tuple[int, int, bool] | None:
    """Значение, разряд и порядковое ли число."""
    clean = _clean(word)
    if clean in _NUMBER_WORDS:
        return (*_NUMBER_WORDS[clean], clean in _ORDINALS)
    for lemma in checker.lemmas(word):
        if lemma in _NUMBER_WORDS:
            return (*_NUMBER_WORDS[lemma], lemma in _ORDINALS)
    for ending in _ORDINAL_ENDINGS:
        if clean.endswith(ending):
            stem = clean[: -len(ending)]
            for tail in ("ый", "ой", "ий"):
                if stem + tail in _NUMBER_WORDS:
                    return (*_NUMBER_WORDS[stem + tail], True)
    return None


def spoken_numbers(text: str, checker: TextChecker) -> str:
    """Числа словами — цифрами: «двадцать четыре» → «24», «на девятом этаже» → «на 9 этаже».

    Подряд идущие слова складываются, пока разряд убывает: «сто двадцать пять» → 125;
    «пять шесть» — два числа. «Ноль» не складывается: так диктуют номер по цифрам —
    «семьдесят ноль ноль пять» → «70 0 0 5», а не «70 0 5».
    """
    spans: list[tuple[int, int, int]] = []
    ordinal: set[int] = set()
    rank = 0
    for match in _WORD.finditer(text):
        found = _number_word(match.group(), checker)
        if found is None:
            rank = 0
            continue
        value, kind, is_ordinal = found
        joined = bool(
            spans
            and rank > kind
            and not text[spans[-1][1] : match.start()].strip()
            and not (kind == 1 and value >= 10 and rank == 2)
            and value != 0
        )
        if joined:
            start, _, total = spans[-1]
            spans[-1] = (start, match.end(), total + value)
        else:
            spans.append((match.start(), match.end(), value))
        if is_ordinal:
            ordinal.add(match.end())
        rank = kind
    for start, end, value in reversed(spans):
        suffix = "-й" if end in ordinal and _HOUSE_AFTER.match(text, end) else ""
        text = f"{text[:start]}{value}{suffix}{text[end:]}"
    return text


@dataclass(frozen=True)
class _Address:
    name: tuple[str, ...]
    street_type: str
    house: str
    building: str = ""


def option_address(label: str) -> _Address | None:
    """Адрес в подписи варианта: название улицы, её тип, дом и корпус; None — адреса нет."""
    for pattern in _ADDRESS:
        match = pattern.search(label)
        if match is not None:
            return _Address(
                (_clean(match.group("name")),),
                _STREET_TYPE[_clean(match.group("type")).rstrip(".")],
                _clean(match.group("house") or ""),
                match.group("building") or "",
            )
    return None


def readback_address(line: str, checker: TextChecker, fix: _Address) -> _Address | None:
    """Адрес, который повторила бригада (`question`): «Каширский проезд, двадцать шесть». Тип
    не назван («Профсоюзная, восемьдесят девять») — тот же, что у верного адреса `fix`;
    None — адреса в реплике нет."""
    text = spoken_numbers(line, checker)
    found = option_address(text)
    if found is not None and found.house:
        return found
    match = _UNTYPED.search(text)
    if match is None:
        return found
    return _Address(
        (_clean(match.group("name")),),
        fix.street_type,
        _clean(match.group("house")),
        match.group("building") or "",
    )


@dataclass(frozen=True)
class _Spoken:
    """Фраза диспетчера: слова (как сказаны и начальные формы) и числа."""

    words: tuple[str, ...]
    lemmas: frozenset[str]
    numbers: frozenset[str]
    # Фраза с числами цифрами: где прозвучал номер дома (`comment.house_said`).
    text: str = ""


def _spoken(text: str, checker: TextChecker) -> _Spoken:
    words: list[str] = []
    lemmas: set[str] = set()
    numbers: set[str] = set()
    text = _JOINED_BUILDING.sub(r"\1 корпус \2", spoken_numbers(text, checker))
    for token in _TOKEN.findall(text):
        if token.isdigit():
            numbers.add(token)
            continue
        clean = _clean(token)
        words.append(clean)
        lemmas.add(clean)
        lemmas |= checker.lemmas(token)
    return _Spoken(tuple(words), frozenset(lemmas), frozenset(numbers), text)


def _word_said(word: str, spoken: _Spoken) -> bool:
    """Слово прозвучало: та же основа в любом падеже — без исправления опечаток."""
    return any(_same_word(word, said) for said in spoken.words)


def _street_type_named(street_type: str, spoken: _Spoken) -> bool:
    """Тип улицы назван словом: «шоссе», «бульвар», «ул.»."""
    return any(
        _STREET_TYPE.get(said) == street_type or _same_word(street_type, said)
        for said in spoken.words
    )


def _street_type_said(street_type: str, spoken: _Spoken, implied: bool = False) -> bool:
    """Тип улицы прозвучал или подразумевается: другой тип не назван, а это «улица»
    («Люблинская, сто» — Люблинская улица, как во вводной, `evalcore.briefing`) или тип
    `implied` — в нём повтор бригады не ошибся."""
    if (implied or street_type == "улица") and not any(
        said in _STREET_TYPE for said in spoken.words
    ):
        return True
    return _street_type_named(street_type, spoken)


def _building_named(building: str, spoken: _Spoken) -> bool:
    """Корпус назван: «корпус 2», «к. 2» (слитное «98к2» уже разведено, `_spoken`)."""
    return bool(
        re.search(
            rf"(?<![0-9а-я])(?:корпус[а-я]*|корп|к)\.?\s*{re.escape(building)}(?!\d)",
            _clean(spoken.text),
        )
    )


def _address_matches(address: _Address, spoken: _Spoken, wrong: _Address | None = None) -> bool:
    """Фраза называет адрес подписи; `wrong` — ошибочный повтор бригады, от которого фраза
    должна отличать верный адрес (docstring модуля)."""
    type_kept = wrong is not None and wrong.street_type == address.street_type
    if not (
        all(_word_said(word, spoken) for word in address.name)
        and _street_type_said(address.street_type, spoken, implied=type_kept)
        and (
            not address.house
            or house_said(spoken.text, address.house, address.name, address.building)
        )
    ):
        return False
    if wrong is None:
        return True
    same_name = len(wrong.name) == len(address.name) and all(
        _same_word(a, b) for a, b in zip(wrong.name, address.name, strict=True)
    )
    if not same_name or wrong.house != address.house:
        # Название и дом подписи обязательны: ошибку в них фраза уже поправила.
        return True
    if type_kept and wrong.building == address.building:
        # Повтор не отличается от подписи — отличать не от чего.
        return True
    return (not type_kept and _street_type_named(address.street_type, spoken)) or (
        wrong.building != address.building
        and bool(address.building)
        and _building_named(address.building, spoken)
    )


# Подтверждение приёма — одно слово с разными формами: «Понял» в подписи отвечает и на
# «Принято», и на «Ясно» (проверка 17.10: «Принято» на повтор адреса — «Не понял, повторите»).
_CONFIRM = frozenset({"понять", "принять", "принятый", "ясно", "ясный", "записать"})
# Номер телефона или карточки — сам по себе ответ: «плюс 79000000717» без слов «телефон
# заявителя» — это он (проверка 17.10).
_LONG_NUMBER = 5


# Телефон в подписи: не меньше 10 цифр с разделителями — «+79000000714», «+7 900 000-07-14».
_PHONE = re.compile(r"\+?\d(?:[\s()\-]*\d){9,}")
# Номер во фразе: цифры, между которыми только разделители — «7 900 0 0 0 0 7 14».
_DIGIT_RUN = re.compile(r"\d(?:[\s()\-.,+]*\d)*")
# Сколько последних цифр телефона хватает: 4 — номер сказан целиком только хвостом
# («ноль семь четырнадцать»), 7 — дальше код оператора, его могут сказать иначе.
_PHONE_TAIL = (4, 7)


def _digits(text: str) -> str:
    """Только цифры; «8» в начале 11-значного номера — «7» (8 900 … = +7 900 …)."""
    digits = re.sub(r"\D", "", text)
    return "7" + digits[1:] if len(digits) == 11 and digits[0] == "8" else digits


def _phone_said(phone: str, spoken: _Spoken) -> bool | None:
    """Телефон прозвучал (True), прозвучал другой номер (False), номера нет (None).

    Номер во фразе совпадает, если его последние цифры — последние цифры телефона: не меньше
    4, а номер короче 7 цифр — целиком (чужой «0714» в «240714» не засчитан).
    """
    other = False
    for match in _DIGIT_RUN.finditer(spoken.text):
        said = _digits(match.group())
        if len(said) < _PHONE_TAIL[0]:
            continue
        common = 0
        for a, b in zip(reversed(said), reversed(phone), strict=False):
            if a != b:
                break
            common += 1
        if common >= _PHONE_TAIL[0] and (common >= _PHONE_TAIL[1] or common == len(said)):
            return True
        other = True
    return False if other else None


def _surname_span(label: str, caller_name: str) -> tuple[int, int] | None:
    """Где в подписи ФИО заявителя: полностью, «Фамилия Имя» или одна фамилия."""
    words = caller_name.split()
    for size in range(len(words), 0, -1):
        start = label.find(" ".join(words[:size]))
        if start >= 0:
            return start, start + len(" ".join(words[:size]))
    return None


def _share(
    label: str, spoken: _Spoken, checker: TextChecker, caller_name: str = ""
) -> float | None:
    """Доля прозвучавших слов и чисел подписи; None — вариант не подходит.

    Поля карточки (телефон, ФИО) — необязательные: из доли исключены, прозвучав — решают.
    """
    field_said = False
    for match in reversed(list(_PHONE.finditer(label))):
        phone = _phone_said(_digits(match.group()), spoken)
        if phone is False:
            return None
        field_said = field_said or bool(phone)
        label = label[: match.start()] + " " + label[match.end() :]
    span = _surname_span(label, caller_name) if caller_name.strip() else None
    if span is not None:
        field_said = field_said or _word_said(_clean(caller_name.split()[0]), spoken)
        label = label[: span[0]] + " " + label[span[1] :]
    tokens = [
        token
        for token in _TOKEN.findall(spoken_numbers(label, checker))
        if token.isdigit() or (_clean(token) not in _STOP and len(token) > 1)
    ]
    numbers = [token for token in tokens if token.isdigit()]
    if any(number not in spoken.numbers for number in numbers):
        return None
    if field_said or any(len(number) >= _LONG_NUMBER for number in numbers):
        return 1.0
    if not tokens:
        return None
    confirmed = bool(spoken.lemmas & _CONFIRM)

    def said(token: str) -> bool:
        lemmas = checker.lemmas(token) | {_clean(token)}
        return bool(lemmas & spoken.lemmas) or (confirmed and bool(lemmas & _CONFIRM))

    found = len(numbers) + sum(1 for token in tokens if not token.isdigit() and said(token))
    if found < math.ceil(len(tokens) / 2):
        return None
    return found / len(tokens)


def voice_reply_option(
    options: Sequence[dict[str, Json]],
    text: str,
    checker: TextChecker,
    card: dict[str, Json] | None = None,
    question: str = "",
) -> str | None:
    """Ключ варианта ответа, к которому сводится фраза; None — не сопоставлена.

    Формула — в docstring модуля: вариант с адресом — улица, тип и дом; остальные — все
    числа и не меньше половины значимых слов подписи; из подошедших — адрес, затем большая
    доля слов; равенство — None. `card` — карточка сценария: по ней в подписи узнаётся ФИО
    заявителя (`caller_name`), подставленное загрузчиком. `question` — реплика бригады:
    повтор адреса в ней (`readback_address`) — то, от чего поправка должна отличаться.
    """
    if not text.strip():
        return None
    spoken = _spoken(text, checker)
    caller_name = card.get("caller_name") if isinstance(card, dict) else None
    caller_name = caller_name if isinstance(caller_name, str) else ""
    addresses: list[str] = []
    shares: list[tuple[float, str]] = []
    for option in options:
        key, label = option.get("key"), option.get("label")
        if not isinstance(key, str) or not isinstance(label, str):
            continue
        address = option_address(label)
        if address is not None:
            wrong = readback_address(question, checker, address) if question.strip() else None
            if _address_matches(address, spoken, wrong):
                addresses.append(key)
            continue
        share = _share(label, spoken, checker, caller_name)
        if share is not None:
            shares.append((share, key))
    if addresses:
        return addresses[0] if len(addresses) == 1 else None
    if not shares:
        return None
    shares.sort(reverse=True)
    if len(shares) > 1 and shares[0][0] == shares[1][0]:
        return None
    return shares[0][1]


def reply_hints(options: Sequence[dict[str, Json]], scenario: dict[str, Json]) -> tuple[str, ...]:
    """Подсказки распознаванию (hotwords Whisper): подписи вариантов и улицы сценария.

    Улица карточки и улица эталона обе, как у доклада (`report.recognition_hints`): когда
    бригада повторяет адрес с ошибкой, подсказка не тянет ни к одной из улиц.
    """
    hints: list[str] = []
    for option in options:
        label = option.get("label")
        if isinstance(label, str) and label.strip() and label.strip() not in hints:
            hints.append(label.strip())
    card = scenario.get("card")
    reference = scenario.get("reference")
    for address in (
        card.get("address") if isinstance(card, dict) else None,
        reference.get("expected_address") if isinstance(reference, dict) else None,
    ):
        street = address.get("street") if isinstance(address, dict) else None
        if isinstance(street, str) and street.strip() and street.strip() not in hints:
            hints.append(street.strip())
    return tuple(hints)


class _NoLemmas:
    """Проверка без словаря: числа словами — по таблице `_NUMBER_WORDS`, остальное как сказано.
    Для правил вне API (разбор, мир), где словаря начальных форм нет."""

    def check(self, text: str) -> list[SpellingIssue]:
        return []

    def lemmas(self, word: str) -> frozenset[str]:
        return frozenset()


def names_address(label: str, text: str, question: str = "") -> bool:
    """Фраза диспетчера называет адрес подписи варианта (поправку), отличая его от повтора
    бригады `question` — то же правило, что у ответа голосом (`voice_reply_option`), без
    словаря начальных форм. Подпись без адреса — False."""
    address = option_address(label)
    if address is None or not text.strip():
        return False
    checker = _NoLemmas()
    wrong = readback_address(question, checker, address) if question.strip() else None
    return _address_matches(address, _spoken(text, checker), wrong)
