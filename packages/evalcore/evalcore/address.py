"""Адрес: точное сравнение компонентов ручного адреса и поиск другой улицы в комментарии."""

import re

_PREFIXES = {
    "city": frozenset({"г", "город"}),
    "street": frozenset({"ул", "улица"}),
    "house": frozenset({"д", "дом"}),
    "building": frozenset({"к", "корп", "корпус"}),
    "apartment": frozenset({"кв", "квартира"}),
}


# Латинские буквы, неотличимые от русских на экране (TC-10, нормализация перед сверкой):
# «Тверскaя» с латинской «a» — та же «Тверская».
_TWINS = str.maketrans("AaBCcEeHKkMOoPpTXxy", "АаВСсЕеНКкМОоРрТХху")
_WORD = re.compile(r"[A-Za-zА-Яа-яЁё]+")
_CYRILLIC = re.compile(r"[А-Яа-яЁё]")


def cyrillic_twins(text: str) -> str:
    """Латинские двойники русских букв — русскими, только в словах с русскими буквами.

    Длина текста не меняется; слово целиком латиницей («MOSLIFT», «SMS») остаётся как есть.
    """
    return _WORD.sub(
        lambda match: (
            match.group().translate(_TWINS) if _CYRILLIC.search(match.group()) else match.group()
        ),
        text,
    )


def normalize_text(value: str) -> str:
    """Регистр, `ё`, латинские двойники и пунктуация: «Ул. Солёная,д.21» → «ул соленая д 21»."""
    folded = cyrillic_twins(value).casefold().replace("ё", "е")
    return " ".join(re.sub(r"[^0-9a-zа-я]+", " ", folded).split())


def normalize_address_component(field: str, value: str) -> str:
    """Нормализовать регистр, `ё`, двойники, пунктуацию и обозначения поля («ул.», «д.»)."""
    normalized = normalize_text(value)
    prefixes = _PREFIXES.get(field, frozenset())
    return " ".join(token for token in normalized.split() if token not in prefixes)


def address_components_match(field: str, expected: str, actual: str) -> bool:
    """Сравнить компонент точно после нормализации, не принимая похожее название за то же."""
    return normalize_address_component(field, expected) == normalize_address_component(
        field, actual
    )


# Адрес в комментарии ДДС (DT-14, 08.10): диспетчер адрес не вводит, а пишет уточнённый адрес
# в комментарий к статусу. Ниже — поиск другой улицы в свободном тексте.

# Тип улицы не отличает одну улицу от другой («ул.» = «улица», «пр-т» = «проспект»).
_STREET_TYPES = frozenset(
    "улица ул проспект пр пр-т переулок пер шоссе ш бульвар б-р набережная наб площадь пл "
    "проезд пр-д тупик аллея линия".split()
)
# Тип улицы рядом с названием: «ул. Тверская», «Тверская улица». «проезд» и «площадь» сюда не
# входят: «проезд затруднён», «площадь пожара» — не адрес.
_STREET_MARKER = r"(?i:улица|ул|проспект|пр-т|переулок|пер|шоссе|бульвар|б-р|набережная|наб)"
_NAME = r"([А-ЯЁ][А-Яа-яЁё-]{2,})"
_MARKED_NAME = (
    re.compile(rf"(?<![А-Яа-яЁё]){_STREET_MARKER}\.?\s+{_NAME}"),
    re.compile(rf"{_NAME}\s+{_STREET_MARKER}(?![А-Яа-яЁё])"),
)
# Слова с заглавной буквы рядом с типом улицы, которые названием улицы не бывают.
_NOT_STREET = frozenset({"москва", "город", "дом", "корпус", "квартира", "строение"})
# Похожее название: та же первая буква и одна правка (в длинном названии — две):
# «Дубининская» против «Дубнинская». Порог ниже ловил бы обычные слова («местная» — «Лесная»).
_SIMILAR_MIN_LENGTH = 5
_LONG_NAME = 8


def _clean(word: str) -> str:
    return word.casefold().replace("ё", "е")


def street_words(street: str) -> list[str]:
    """Значимые слова названия улицы без её типа: «Дубнинская улица» → ["дубнинская"]."""
    return [
        word
        for word in normalize_address_component("street", street).split()
        if word not in _STREET_TYPES
    ]


# Звание или должность в названии улицы его в речи часто опускают: «Янгеля, 6» — это улица
# Академика Янгеля. Название без звания должно остаться: «Маршала» одно — не улица.
_STREET_TITLES = frozenset(
    "академика маршала генерала адмирала профессора космонавта летчика героя".split()
)


def spoken_street_words(street: str) -> list[str]:
    """Слова названия улицы, которые надо сказать: без звания, если после него что-то есть.

    «улица Академика Янгеля» → ["янгеля"]; «Профсоюзная улица» → ["профсоюзная"].
    """
    words = street_words(street)
    named = [word for word in words if word not in _STREET_TITLES]
    return named or words


def _same_word(left: str, right: str) -> bool:
    """Одно слово в другом падеже: «Дубнинской» = «Дубнинская» (общая основа без окончания)."""
    if left == right:
        return True
    prefix = 0
    for a, b in zip(left, right, strict=False):
        if a != b:
            break
        prefix += 1
    return (
        min(len(left), len(right)) >= _SIMILAR_MIN_LENGTH
        and prefix >= max(len(left), len(right)) - 3
    )


def _edits(left: str, right: str) -> int:
    """Расстояние Левенштейна: вставки, удаления и замены букв."""
    row = list(range(len(right) + 1))
    for i, a in enumerate(left, start=1):
        previous, row[0] = row[0], i
        for j, b in enumerate(right, start=1):
            previous, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, previous + (a != b))
    return row[-1]


def other_street(text: str, expected_street: str) -> str | None:
    """Другая улица в тексте, если она названа; None — другой улицы нет.

    Другая улица — слово с заглавной буквы рядом с типом улицы («ул. Тверская», «Тверская
    улица»), которое не совпадает с эталоном, или слово, отличающееся от названия эталона на
    одну-две буквы («Дубининская» при «Дубнинская»). Тот же корень в другом падеже
    («на Дубнинской улице») — та же улица.
    """
    expected = street_words(expected_street)
    if not expected:
        return None
    text = cyrillic_twins(text).replace("ё", "е").replace("Ё", "Е")
    for pattern in _MARKED_NAME:
        for match in pattern.finditer(text):
            name = _clean(match.group(1))
            if name in _NOT_STREET or any(_same_word(name, word) for word in expected):
                continue
            return match.group(1)
    return similar_street(text, expected_street)


def similar_street(text: str, expected_street: str) -> str | None:
    """Слово, похожее на название эталона, но не оно: опечатка в названии улицы.

    «Дубининская» при «Дубнинская» — одна-две буквы (в коротком названии — одна). Другая
    улица целиком («ул. Ленина») сюда не входит: в комментарии бывают и соседние улицы.
    """
    expected = street_words(expected_street)
    text = cyrillic_twins(text).replace("ё", "е").replace("Ё", "Е")
    for raw in re.findall(r"[А-Яа-яЁё]+(?:-[А-Яа-яЁё]+)*", text):
        word = _clean(raw)
        for target in expected:
            allowed = 2 if len(target) >= _LONG_NAME else 1
            if (
                len(target) >= _SIMILAR_MIN_LENGTH
                and word[:1] == target[:1]
                and not _same_word(word, target)
                and abs(len(word) - len(target)) <= allowed
                and _edits(word, target) <= allowed
            ):
                return raw
    return None
