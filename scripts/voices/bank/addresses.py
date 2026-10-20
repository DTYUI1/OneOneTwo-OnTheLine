"""Фразы бригад, собранные по сценариям и учебным докладам: повтор адреса вводной, ловушка
повтора, прибытие после неверного адреса, доклады ступени 1 и демо — addresses/<служба>.json.

    uv run --package arm112-api python scripts/voices/bank/addresses.py <варианты.json>

В книгах банка адресов нет (README рядом): банк собирает и генератор сценариев. Здесь —
конечный набор адресов самих сценариев data/scenarios: повтор верного адреса и двух похожих
ошибок, которые окно телефона предлагает частями (`addressOptions` в
apps/web/src/arm/softphone/parts.ts; <варианты.json> — код сценария → тексты вариантов).
Что бригада повторит, решает то же правило, что на сервере (evalcore.briefing,
`app.api.training.briefing.readback`), поэтому текст фразы совпадает с ответом сервера
дословно. `say` — то, что уходит в синтез: числа словами. Адрес не из набора бригада не
повторяет (сервер это знает по манифестам озвучки).
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any

from app.api.training.briefing import MOVED_TEXT, readback_text
from app.core.spelling import for_scenario
from evalcore.briefing import briefing_check

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
FEMALE = {"103"}
# Бригада уехала по неверному адресу вводной и доложила о прибытии позже: адреса в докладе
# нет — он мог быть любым (app.api.training.briefing.wrong_arrival).
MOVED = MOVED_TEXT
# Ловушка повтора: диспетчер поправил, но неверно — та же поездка не туда, другими словами
# (ветки «неверно» и «пропустил» в одном сценарии не повторяют фразу).
MOVED_AFTER_WRONG = (
    "Диспетчер, по тому адресу нас никто не ждал. Сверились с карточкой, переехали, "
    "на месте, время потеряли."
)

# Этап доклада учебного сценария C-04 → место разговора банка.
STAGE_SLOT = {
    "departure": "responding",
    "arrival": "arrived",
    "works": "working",
    "completion": "completed",
    "complication": "refused",
}

UNITS = ["", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"]
TEENS = [
    "десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать", "пятнадцать",
    "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать",
]  # fmt: skip
TENS = [
    "", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят",
    "восемьдесят", "девяносто",
]  # fmt: skip
HUNDREDS = [
    "", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот",
    "восемьсот", "девятьсот",
]  # fmt: skip
THOUSANDS = ["", "одна тысяча", "две тысячи", "три тысячи", "четыре тысячи", "пять тысяч"]


def words(number: int) -> str:
    """Номер дома словами, как его диктуют: «сто четыре», «одна тысяча четыре»."""
    parts = [THOUSANDS[number // 1000], HUNDREDS[number // 100 % 10]]
    rest = number % 100
    if 10 <= rest < 20:
        parts.append(TEENS[rest - 10])
    else:
        parts += [TENS[rest // 10], UNITS[rest % 10]]
    return " ".join(part for part in parts if part)


def spoken(text: str) -> str:
    """Цифры — словами; остальное как есть."""
    out, digits = [], ""
    for char in text + " ":
        if char.isdigit():
            digits += char
            continue
        if digits:
            out.append(words(int(digits)))
            digits = ""
        out.append(char)
    return "".join(out).strip()


def phrase(service: str, slot: str, text: str) -> dict[str, Any]:
    digest = hashlib.sha256(text.encode()).hexdigest()[:8]
    item: dict[str, Any] = {
        "id": f"{service}.{slot}.{digest}",
        "slot": slot,
        "incidents": ["*"],
        "text": text,
    }
    say = spoken(text)
    if say != text:
        item["say"] = say
    return item


def main() -> None:
    options = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    books: dict[str, dict[str, dict[str, Any]]] = {}
    for path in sorted((ROOT / "data" / "scenarios").glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        service = data["service_id"]
        book = books.setdefault(service, {})
        scenario = {
            "incident_type_code": data["incident_type_code"],
            "card": data["card"],
            "reference": data["reference"],
        }
        checker = for_scenario((), data["card"], data["reference"])
        incident = data["card"].get("incident_class") or data["card"].get("description", "")
        for option in options.get(data["code"], []):
            heard = briefing_check(scenario, f"{option}. {incident}", checker)
            text = readback_text(heard, service)
            if text:
                item = phrase(service, "readback", text)
                book[item["id"]] = item
        for event in data.get("events", []):
            line = event.get("line")
            if event["kind"] == "readback_error" and line:
                text = line if isinstance(line, str) else line["text"]
                item = phrase(service, "readback_trap", text)
                book[item["id"]] = item
    for service, book in books.items():
        for key, text in (("moved", MOVED), ("moved2", MOVED_AFTER_WRONG)):
            book[f"{service}.wrong_place.{key}"] = {
                "id": f"{service}.wrong_place.{key}",
                "slot": "wrong_place",
                "incidents": ["*"],
                "text": text,
            }
    # Доклады учебных сценариев C-04 (ступень 1, демо; app.seed.training): тексты — манифесты
    # data/voices/brigade. Фраза, которая уже есть в книге службы, берётся оттуда.
    known = {
        (book["service"], item["text"])
        for path in sorted((HERE / "phrases").glob("*.json"))
        for book in [json.loads(path.read_text(encoding="utf-8"))]
        for item in book["phrases"]
    }
    for name in ("manifest.json", "completion.pending.json", "complication.pending.json"):
        path = ROOT / "data" / "voices" / "brigade" / name
        for message in json.loads(path.read_text(encoding="utf-8"))["messages"]:
            service, text = message["service_id"], message["text"]
            if (service, text) in known or service not in books:
                continue
            slot = STAGE_SLOT[message["stage"]]
            item = {
                "id": f"{service}.{slot}.c04.{message['stage']}",
                "slot": slot,
                "incidents": ["*"],
                "text": text,
            }
            books[service][item["id"]] = item
    out = HERE / "addresses"
    out.mkdir(exist_ok=True)
    for service, phrases in sorted(books.items()):
        doc = {
            "service": service,
            "speaker": "brigade",
            "gender": "female" if service in FEMALE else "male",
            "phrases": sorted(phrases.values(), key=lambda item: item["id"]),
        }
        (out / f"{service}.json").write_text(
            json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(f"{service}: {len(phrases)} фраз")


if __name__ == "__main__":
    main()
