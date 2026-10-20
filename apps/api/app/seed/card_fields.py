"""Поля карточки в подписях вариантов ответа: `{caller_phone}`, `{caller_name}`, `{address}`.

Вариант ответа бригаде (`reply_options[].label`) — текст на кнопке, его не озвучивают: в нём
можно сослаться на поле карточки сценария, а не повторять телефон и ФИО заявителя (HQ-009).
Загрузчик (`app.seed.scenarios.training_plan`) подставляет значения из `card` сценария, и
дальше план везде с готовым текстом: выдача, окно телефона, распознавание ответа голосом,
разбор. Карточка занятия — копия `card` сценария, значения совпадают.

В репликах (доклад, событие, ответ ветки, подмена) подстановки нет: их текст совпадает с
записью озвучки. Неизвестное имя, пустое поле карточки или плейсхолдер в реплике — ошибка
линтера (`problems`).
"""

import copy
import re
from collections.abc import Callable, Iterator
from typing import Any

PLACEHOLDER = re.compile(r"\{([^{}]*)\}")
# Подпись варианта в файле сценария — короче 60 символов (GP-06) и после подстановки.
LABEL_LIMIT = 59


def _phone(card: dict[str, Any]) -> str:
    """Телефон заявителя, как его видит диспетчер: названный, иначе АОН, иначе с места.

    Мобильный номер — группами, как его диктуют: «+7 900 000-07-14» (голосом сравнивают по
    цифрам, `evalcore.voice_reply`); другой вид номера — как в карточке.
    """
    for field in ("phone_provided", "phone_aon", "phone_scene"):
        value = card.get(field)
        if isinstance(value, str) and value.strip():
            digits = re.sub(r"\D", "", value)
            if len(digits) == 11 and digits[0] in "78":
                return f"+7 {digits[1:4]} {digits[4:7]}-{digits[7:9]}-{digits[9:]}"
            return value.strip()
    return ""


def _address(card: dict[str, Any]) -> str:
    """Адрес карточки так, как его говорят бригаде: «Люблинская улица, 100, кв. 34»."""
    address = card.get("address")
    if not isinstance(address, dict):
        return ""

    def part(name: str) -> str:
        value = address.get(name)
        return value.strip() if isinstance(value, str) else ""

    parts = [part("street"), part("house")]
    if part("building"):
        parts.append(f"корп. {part('building')}")
    if part("apartment"):
        parts.append(f"кв. {part('apartment')}")
    return ", ".join(item for item in parts if item)


def _name(card: dict[str, Any]) -> str:
    """Заявитель «Фамилия Имя»: так его называют бригаде (отчество — в карточке), и так
    подпись была написана до подстановки («Тимофеев Олег, телефон в карточке»)."""
    value = card.get("caller_name")
    return " ".join(value.split()[:2]) if isinstance(value, str) else ""


FIELDS: dict[str, Callable[[dict[str, Any]], str]] = {
    "caller_phone": _phone,
    "caller_name": _name,
    "address": _address,
}


def fill(label: str, card: dict[str, Any]) -> str:
    """Подпись с подставленными полями карточки (неизвестное имя остаётся как есть)."""

    def value(match: re.Match[str]) -> str:
        field = FIELDS.get(match.group(1))
        return field(card) if field is not None else match.group(0)

    return PLACEHOLDER.sub(value, label)


def _options(data: dict[str, Any]) -> Iterator[tuple[str, dict[str, Any]]]:
    for event in data.get("events", []):
        for option in event.get("reply_options", []):
            yield f"событие «{event['key']}», вариант «{option['key']}»", option
    for option in data.get("control_call", {}).get("reply_options", []):
        yield f"звонок отдела контроля, вариант «{option['key']}»", option


def with_card_fields(data: dict[str, Any]) -> dict[str, Any]:
    """Копия сценария, в подписях вариантов которой подставлены поля карточки."""
    if not any(PLACEHOLDER.search(option["label"]) for _, option in _options(data)):
        return data
    filled = copy.deepcopy(data)
    for _, option in _options(filled):
        option["label"] = fill(option["label"], filled["card"])
    return filled


def _text(line: Any) -> str | None:
    if line is None:
        return None
    return line if isinstance(line, str) else str(line.get("text", ""))


def _spoken(data: dict[str, Any]) -> Iterator[tuple[str, str]]:
    """Реплики сценария, которые звучат: доклады, события, ответы веток, подмены."""
    for report in data["plan"]:
        yield f"доклад «{report['key']}»", str(_text(report["line"]))
    for event in data.get("events", []):
        where = f"событие «{event['key']}»"
        if (line := _text(event["line"])) is not None:
            yield where, line
        for name, branch in event["branches"].items():
            if (line := _text(branch["line"])) is not None:
                yield f"{where}, ветка {name}", line
            for effect in branch["effects"]:
                if "with" in effect:
                    yield f"{where}, подмена в ветке {name}", str(_text(effect["with"]))


def problems(data: dict[str, Any]) -> list[str]:
    """Ошибки подстановки: неизвестное поле, пустое поле карточки, длинная подпись после
    подстановки, плейсхолдер в озвучиваемой реплике."""
    found = []
    card = data.get("card", {})
    known = ", ".join(f"{{{name}}}" for name in FIELDS)
    for where, option in _options(data):
        names = PLACEHOLDER.findall(option["label"])
        for name in names:
            if name not in FIELDS:
                found.append(f"{where}: неизвестное поле карточки {{{name}}} (есть: {known})")
            elif not FIELDS[name](card):
                found.append(f"{where}: поле карточки {{{name}}} пустое — подставлять нечего")
        if names and len(filled := fill(option["label"], card)) > LABEL_LIMIT:
            found.append(f"{where}: после подстановки «{filled}» длиннее {LABEL_LIMIT} символов")
    for where, line in _spoken(data):
        if PLACEHOLDER.search(line):
            found.append(
                f"{where}: поле карточки в реплике — подстановка только в вариантах ответа "
                "(реплику озвучивают как написано)"
            )
    return found
