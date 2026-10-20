"""Разовый перевод тренировки `data/practice` в файлы формата 2 (`data/scenarios`).

`python -m app.seed.convert_practice` пишет по файлу на службу и уровень происшествия с
прежним UUID сценария (поле `id`), тем же планом докладов и событиями, что строил прежний
seed (`app.seed.practice`). Так на развёрнутых стендах сценарии не задваиваются и журналы
читаются как раньше. Дальше сценарий правится в `data/scenarios` — новой версией.
Существующие файлы не перезаписываются.
"""

import json
import sys
from pathlib import Path
from typing import Any

from app.core.config import ROOT
from app.seed.practice import (
    AFTER_S,
    audio_path,
    event_audio_path,
    live,
    load_incidents,
    scenario_id,
    scenario_payload,
    stages,
    variants,
)
from app.seed.scenarios import SCENARIOS_DIR

BRIGADE = "b1"


def code(key: str, service_id: str, level: int) -> str:
    return f"{key}-{service_id.lower()}-{level}"


def convert_events(key: str, service_id: str, block: dict[str, Any]) -> list[dict[str, Any]]:
    def voiced(text: str | None, event_key: str, part: str = "") -> dict[str, Any] | None:
        if text is None:
            return None
        return {"text": text, "audio": event_audio_path(key, service_id, event_key, part)}

    events = []
    for raw in block["events"]:
        event_key = raw["key"]
        trigger = {k: v for k, v in raw["trigger"].items() if k not in {"stage", "event"}}
        if "stage" in raw["trigger"]:
            trigger["report"] = raw["trigger"]["stage"]
        if "event" in raw["trigger"]:
            trigger["event"] = raw["trigger"]["event"]
        first_branch: dict[str, str] = {}
        branches = {}
        for name, branch in raw["branches"].items():
            effects = []
            for item in branch["effects"]:
                if "delay" in item:
                    effects.append(item)
                    continue
                part = f"{first_branch.setdefault(item['with'], name)}-replace"
                effects.append(
                    {"replace": item["replace"], "with": voiced(item["with"], event_key, part)}
                )
            branches[name] = {"line": voiced(branch["line"], event_key, name), "effects": effects}
        event = {
            "key": event_key,
            "kind": raw["kind"],
            **({"priority": raw["priority"]} if "priority" in raw else {}),
            "trigger": trigger,
            "line": voiced(raw["line"], event_key),
            "expect": raw["expect"],
            **({"reply_options": raw["reply_options"]} if "reply_options" in raw else {}),
            "branches": branches,
            "review": raw["review"],
            **({"injectable": raw["injectable"]} if "injectable" in raw else {}),
        }
        events.append(event)
    return events


def convert(
    incident: dict[str, Any], service_id: str, level: int, phone_ext: str
) -> dict[str, Any]:
    key = incident["key"]
    payload = scenario_payload(incident, service_id, level, phone_ext)
    variant = incident["services"][service_id]
    block = live(variant, level)
    pauses = {**AFTER_S, **((block or {}).get("after_s") or {})}
    events = convert_events(key, service_id, block) if block else []
    result: dict[str, Any] = {
        "format": 2,
        "code": code(key, service_id, level),
        "version": 1,
        "id": payload["id"],
        "title": incident["title"],
        "service_id": service_id,
        "level": level,
        "weight": payload["weight"],
        "incident_type_code": payload["incident_type_code"],
        "complications": payload["complications"],
        "teacher_comment": payload["teacher_comment"],
        "card": payload["card"],
        "reference": payload["reference"],
        "brigades": [{"key": BRIGADE, "ordinal": 0}],
        "plan": [
            {
                "key": stage.name,
                "brigade": BRIGADE,
                "line": {
                    "text": stage.text,
                    "audio": audio_path(key, service_id, level, stage.name),
                },
                "after_s": pauses[stage.name],
                "requires_state": stage.requires,
                "justifies_state": stage.justifies,
            }
            for stage in stages(variant, level)
        ],
    }
    if events:
        result["events"] = events
        traps = [event["key"] for event in events if event["kind"] == "readback_error"]
        if traps:
            result["traps"] = traps
    assert result["id"] == str(scenario_id(key, service_id, level))
    return result


def main(directory: Path = SCENARIOS_DIR) -> None:
    phonebook = {
        item["id"]: item["phone_ext"]
        for item in json.loads((ROOT / "data" / "phonebook.json").read_text(encoding="utf-8"))
    }
    directory.mkdir(parents=True, exist_ok=True)
    written = 0
    for incident in load_incidents():
        for service_id, level in variants(incident):
            if service_id not in phonebook:
                continue
            data = convert(incident, service_id, level, phonebook[service_id])
            path = directory / f"{data['code']}.json"
            if path.exists():
                continue
            path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            written += 1
    sys.stdout.write(f"Записано файлов: {written}\n")


if __name__ == "__main__":
    main()
