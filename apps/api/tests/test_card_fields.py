"""Поля карточки в подписях вариантов ответа (HQ-009): `{caller_phone}`, `{caller_name}`,
`{address}` — загрузчик подставляет значения из карточки сценария, реплики не трогает."""

import asyncio
import copy
import json
from typing import Any

from app.seed.card_fields import fill, with_card_fields
from app.seed.scenario_lint import lint
from app.seed.scenarios import SCENARIOS_DIR, training_plan


def scenario(code: str) -> dict[str, Any]:
    return json.loads((SCENARIOS_DIR / f"{code}.json").read_text(encoding="utf-8"))


def options(data: dict[str, Any], key: str) -> dict[str, str]:
    event = next(item for item in data["events"] if item["key"] == key)
    return {item["key"]: item["label"] for item in event["reply_options"]}


async def no_audio(path: str, text: str) -> None:
    return None


def plan_events(data: dict[str, Any]) -> list[dict[str, Any]]:
    return asyncio.run(training_plan(data, no_audio))["events"]


def test_fill_takes_values_from_card():
    card = {
        "caller_name": "Белова Анна Михайловна",
        "phone_aon": "+79000000716",
        "phone_provided": "",
        "address": {"street": "улица Плеханова", "house": "11", "building": "", "apartment": "34"},
    }
    assert fill("Телефон: {caller_phone}", card) == "Телефон: +7 900 000-07-16"
    # Бригаде заявителя называют «Фамилия Имя», отчество — в карточке.
    assert fill("{caller_name}, тел. в карточке", card) == "Белова Анна, тел. в карточке"
    assert fill("Адрес: {address}", card) == "Адрес: улица Плеханова, 11, кв. 34"
    # Названный заявителем телефон важнее АОН.
    assert fill("{caller_phone}", {**card, "phone_provided": "89000000001"}) == "+7 900 000-00-01"
    # Не мобильный номер — как в карточке.
    assert fill("{caller_phone}", {**card, "phone_provided": "112"}) == "112"


def test_catalog_scenarios_use_card_fields_in_labels():
    """Пять сценариев HQ-009 ссылаются на карточку; план — с готовым текстом из карточки."""
    cases = {
        "fight-street-102-2": ("caller-phone", "phone", "Телефон заявителя: +7 900 000-07-17"),
        "gas-apartment-104-2": ("phone", "phone", "Телефон заявителя: +7 900 000-07-14"),
        "heart-street-103-2": ("caller-phone", "aon", "Телефон заявителя: +7 900 000-07-16"),
        "traffic-blocked-102-1": ("caller", "phone", "Телефон заявителя: +7 900 000-07-13"),
        "traffic-blocked-103-2": ("caller", "caller", "Тимофеев Олег, телефон в карточке"),
    }
    for code, (event_key, option_key, label) in cases.items():
        data = scenario(code)
        assert "{" in options(data, event_key)[option_key], code
        assert lint(data) == [], code
        events = {item["id"]: item for item in plan_events(data)}
        planned = [item for item in events.values() if item.get("reply_options")]
        labels = {o["label"] for item in planned for o in item["reply_options"]}
        assert label in labels, code
        assert not any("{" in text for text in labels), code


def test_spoken_lines_are_not_substituted():
    """Реплики бригады — как в файле: их текст совпадает с записью озвучки."""
    data = scenario("traffic-blocked-103-2")
    plan = asyncio.run(training_plan(data, no_audio))
    filled = with_card_fields(data)
    spoken = [item["message"]["text"] for item in plan["messages"]]
    spoken += [item["line"]["text"] for item in plan["events"] if item["line"]]
    raw = [r["line"] if isinstance(r["line"], str) else r["line"]["text"] for r in data["plan"]]
    assert spoken[: len(raw)] == raw
    # Подставляет только подписи вариантов; файл не меняется.
    assert filled is not data
    assert options(data, "caller")["caller"] == "{caller_name}, телефон в карточке"


def test_lint_rejects_unknown_empty_and_spoken_placeholders():
    data = scenario("fight-street-102-2")
    broken = copy.deepcopy(data)
    event = next(item for item in broken["events"] if item["key"] == "caller-phone")
    event["reply_options"][1]["label"] = "Звоните {caller_mobile}"
    assert any("неизвестное поле карточки {caller_mobile}" in item for item in lint(broken))

    empty = copy.deepcopy(data)
    for field in ("phone_aon", "phone_provided", "phone_scene"):
        empty["card"][field] = ""
    assert any("{caller_phone} пустое" in item for item in lint(empty))

    spoken = copy.deepcopy(data)
    spoken["plan"][0]["line"] = "Вызов принят, заявитель {caller_name}."
    assert any("поле карточки в реплике" in item for item in lint(spoken))
