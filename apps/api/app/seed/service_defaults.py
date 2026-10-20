"""Просьба о службе, которую уже вызвали (GP-28): ветки и варианты ответа по умолчанию.

Бригада просит вызвать другую службу (событие `request_service`). Если диспетчер вызвал её
заранее, мир решает исход по правилу `evalcore.brigade` («служба вызвана заранее»):
ветка `already` — бригаде сказали «уже едут» после её просьбы, `surprise` — не сказали, и
служба приехала сама. Чтобы каждому сценарию не дописывать эти ветки руками, загрузчик
достраивает их, если в файле их нет:

- **реплика ветки** — фраза банка озвучки службы бригады (`scripts/voices/bank/phrases`):
  `already` — место `service_coming` («Понял, ждём скорую.»), `surprise` — `service_surprise`
  («Скорая подъехала. Хорошо, конечно, но могли бы и сказать, что вызвали.»), `needs` — служба
  из номеров ожидания (кроме 112). Из подходящих первой идёт фраза, где служба названа тем же
  словом, что в просьбе («спасатели», а не «пожарные»); фраза в сценарии не повторяется.
  Запись — из набора `data/voices/bank-v*` по id фразы; нет записи — реплика уходит текстом;
- **последствия** — как у ветки `met`: служба приехала, мир в порядке;
- **варианты ответа** — «Уже вызвал, едут» (`already`) и «Понял, вызываю» (`calling`), если в
  файле своих вариантов нет. Правильного варианта нет: оценивается звонок, а «уже вызвал»
  засчитывается, только если служба действительно вызвана.

Явные ветки и варианты в файле главнее: загрузчик их не трогает.
"""

import copy
import json
import re
from functools import lru_cache
from typing import Any

from evalcore.service_told import ALREADY_OPTION, CALLING_OPTION

from app.core.config import ROOT

BANK_DIR = ROOT / "scripts" / "voices" / "bank" / "phrases"
VOICES_DIR = ROOT / "data" / "voices"
PHONEBOOK = ROOT / "data" / "phonebook.json"
# Ветка → место фразы банка.
BRANCH_SLOTS = {"already": "service_coming", "surprise": "service_surprise"}
REPLY_OPTIONS = (
    {"key": ALREADY_OPTION, "label": "Уже вызвал, едут"},
    {"key": CALLING_OPTION, "label": "Понял, вызываю"},
)
# Как бригада называет службу: фраза с тем же словом, что в просьбе, идёт первой.
NOUNS = (
    "скор",
    "врач",
    "медик",
    "пожарн",
    "спасател",
    "полиц",
    "наряд",
    "участков",
    "газов",
    "мосгаз",
    "аварийк",
    "сантехник",
    "слесар",
    "коммунальщик",
    "механик",
    "лифт",
)
SYSTEM_112 = "112"


def _text(line: str | dict[str, Any] | None) -> str | None:
    if line is None:
        return None
    return line if isinstance(line, str) else str(line["text"])


@lru_cache
def bank_book(service_id: str) -> tuple[dict[str, Any], ...]:
    """Фразы книги банка службы; книги нет — пусто."""
    path = BANK_DIR / f"{service_id}.json"
    if not path.exists():
        return ()
    return tuple(json.loads(path.read_text(encoding="utf-8"))["phrases"])


@lru_cache
def phone_services() -> dict[str, str]:
    """Номер службы → служба справочника (105 → GKH, 106 → MOSLIFT)."""
    return {
        str(item["phone_ext"]): str(item["id"])
        for item in json.loads(PHONEBOOK.read_text(encoding="utf-8"))
    }


def _version(folder: str) -> int:
    found = re.fullmatch(r"bank-v(\d+)", folder)
    return int(found.group(1)) if found else 0


@lru_cache
def voiced() -> dict[str, dict[str, Any]]:
    """Id фразы банка → запись в самом новом наборе bank-v* (путь, текст)."""
    found: dict[str, dict[str, Any]] = {}
    folders = sorted(
        (path.parent for path in VOICES_DIR.glob("bank-v*/manifest.json")),
        key=lambda path: _version(path.name),
    )
    for folder in folders:
        manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
        for item in manifest["messages"]:
            if "id" in item:
                found[item["id"]] = item
    return found


def needed_service(event: dict[str, Any]) -> str | None:
    """Служба, которую просит бригада: первый номер ожидания `call_service`, кроме 112."""
    services = phone_services()
    for expect in event["expect"]:
        if expect["action"] != "call_service":
            continue
        for ext in expect.get("phone_exts", []):
            service = services.get(str(ext), str(ext))
            if service != SYSTEM_112:
                return service
    return None


def bank_line(
    service_id: str, slot: str, needs: str, request: str | None, used: set[str]
) -> dict[str, Any] | None:
    """Фраза банка для ветки: место, нужная служба, то же слово службы, что в просьбе."""
    candidates = [
        phrase
        for phrase in bank_book(service_id)
        if phrase["slot"] == slot
        and phrase.get("needs") == needs
        and "*" in phrase["incidents"]
        and phrase["text"] not in used
    ]
    said = {noun for noun in NOUNS if noun in (request or "").lower().replace("ё", "е")}
    candidates.sort(
        key=lambda phrase: not any(noun in phrase["text"].lower() for noun in said),
    )
    if not candidates:
        return None
    phrase = candidates[0]
    item = voiced().get(phrase["id"])
    if item is not None and item["text"] == phrase["text"]:
        return {"text": phrase["text"], "audio": item["path"]}
    return {"text": phrase["text"]}


def _used_texts(data: dict[str, Any]) -> set[str]:
    """Все реплики бригад файла: фраза в сценарии не повторяется."""
    used = {_text(report["line"]) for report in data["plan"]}
    for event in data.get("events", []):
        used.add(_text(event["line"]))
        for branch in event["branches"].values():
            used.add(_text(branch["line"]))
            used |= {_text(effect.get("with")) for effect in branch["effects"]}
    return {text for text in used if text}


def with_service_defaults(data: dict[str, Any]) -> dict[str, Any]:
    """Файл сценария с ветками `already` / `surprise` и вариантами ответа у каждой просьбы
    о службе, где их нет (правила — в docstring модуля). Исходный словарь не меняется."""
    result = copy.deepcopy(data)
    used = _used_texts(result)
    for event in result.get("events", []):
        if event["kind"] != "request_service":
            continue
        needs = needed_service(event)
        if needs is None:
            continue
        if "reply_options" not in event:
            event["reply_options"] = [dict(option) for option in REPLY_OPTIONS]
        met = event["branches"].get("met", {"effects": []})
        for branch, slot in BRANCH_SLOTS.items():
            if branch in event["branches"]:
                continue
            line = bank_line(result["service_id"], slot, needs, _text(event["line"]), used)
            if line is not None:
                used.add(line["text"])
            event["branches"][branch] = {
                "line": line,
                "effects": copy.deepcopy(met["effects"]),
            }
    return result
