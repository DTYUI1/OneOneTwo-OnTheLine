"""Учебные адреса без изменения записанных реплик и признаков пути."""

import copy
import json
import random
import re
from functools import lru_cache
from typing import Any

from app.core.config import ROOT

LOCATION = ("city", "street", "house", "building", "okrug", "district")
STREET_TYPES = {
    "улица",
    "проспект",
    "шоссе",
    "переулок",
    "набережная",
    "бульвар",
    "проезд",
    "площадь",
}


@lru_cache
def locations() -> tuple[dict[str, str], ...]:
    found = {}
    for path in sorted((ROOT / "data/scenarios").glob("*.json")):
        data = json.loads(path.read_text())
        address = data.get("card", {}).get("address", {})
        if not address.get("street") or not address.get("house"):
            continue
        value = {key: address.get(key, "") for key in LOCATION}
        found[tuple(value.values())] = value
    # Небольшой поставляемый справочник улиц: только записи с известным районом.
    # Номер дома для учебной карточки берётся из каталога, а не выдаётся за ФИАС.
    path = ROOT / "data/operator/streets.json"
    if path.exists():
        houses = sorted({a["house"] for a in found.values()})
        for street in json.loads(path.read_text()).get("streets", []):
            if not all(street.get(key) for key in ("city", "street", "district", "okrug")):
                continue
            if any(a["street"] == street["street"] for a in found.values()):
                continue
            for house in houses:
                value = {key: street.get(key, "") for key in LOCATION}
                value["house"] = house
                found[tuple(value.values())] = value
    return tuple(found.values())


def mentions_location(text: str, address: dict[str, str]) -> bool:
    normalized = text.casefold().replace("ё", "е")
    words = re.findall(r"[а-я]+", address["street"].casefold().replace("ё", "е"))
    roots = [word[:5] for word in words if len(word) >= 4 and word not in STREET_TYPES]
    if any(root in normalized for root in roots):
        return True
    house = re.escape(address.get("house", ""))
    if house and re.search(rf"(?<!\w){house}(?!\w)", normalized):
        return True
    # Не переписываем адрес, если номер дома произносится словами.
    return bool(
        re.search(
            r"\bдом(?:а|е|у|ом)?\s+(?:номер\s+)?"
            r"(?:перв|втор|трет|четвер|пят|шест|сед|вос|дев|десят|один|дв|три|четыр|сто|сорок)",
            normalized,
        )
    )


def strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [text for item in value.values() for text in strings(item)]
    if isinstance(value, list):
        return [text for item in value for text in strings(item)]
    return []


def change(data: dict[str, Any], seed: int) -> bool:
    from app.worker.generators import gameplay

    if any(e["kind"] == "readback_error" for e in data.get("events", [])):
        return False
    old = data["card"]["address"]
    lines = [r["line"] for r in data["plan"]] + gameplay.event_lines(data)
    texts = [line["text"] for line in lines] + [data["card"]["description"]]
    # Непроизносимые итоги тоже не оставляем привязанными к прежнему месту.
    texts += strings(data.get("outcome", {}))
    texts += strings(data.get("events", []))
    texts.append(data["reference"].get("expected_comment", ""))
    if any(mentions_location(text, old) for text in texts if isinstance(text, str)):
        return False
    candidates = [a for a in locations() if a["street"] != old["street"]]
    if not candidates:
        return False
    selected = random.Random(f"{seed}:address").choice(candidates)
    # Квартиру, этаж и подъезд оставляем: они относятся к истории и могут звучать.
    new = {**old, **selected}
    data["card"]["address"] = new
    data["reference"]["expected_address"] = copy.deepcopy(new)
    # {address} остаётся ссылкой: загрузчик подставляет новую карточку при сборке плана.
    return True
