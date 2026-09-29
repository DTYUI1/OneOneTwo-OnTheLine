"""Точное сравнение структурированных компонентов ручного адреса."""

import re

_PREFIXES = {
    "city": frozenset({"г", "город"}),
    "street": frozenset({"ул", "улица"}),
    "house": frozenset({"д", "дом"}),
    "building": frozenset({"к", "корп", "корпус"}),
    "apartment": frozenset({"кв", "квартира"}),
}


def normalize_address_component(field: str, value: str) -> str:
    """Нормализовать регистр, `ё`, пунктуацию и общеупотребительные обозначения поля."""
    normalized = " ".join(re.sub(r"[^0-9a-zа-я]+", " ", value.casefold().replace("ё", "е")).split())
    prefixes = _PREFIXES.get(field, frozenset())
    return " ".join(token for token in normalized.split() if token not in prefixes)


def address_components_match(field: str, expected: str, actual: str) -> bool:
    """Сравнить компонент точно после нормализации, не принимая похожее название за то же."""
    return normalize_address_component(field, expected) == normalize_address_component(
        field, actual
    )
