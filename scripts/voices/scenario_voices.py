"""Набор голосов сценариев ДДС: что озвучить и как переключить сценарии на новый набор (GP-15).

    python3 scripts/voices/scenario_voices.py todo <набор>    # список реплик → stdout (JSON)
    python3 scripts/voices/scenario_voices.py switch <набор>  # сценарии → новый набор, version+1

Набор — папка `data/voices/<набор>/` со своим `manifest.json` (seed ищет запись в манифесте
первой папки пути, contracts/scenario-file.schema.json, Line). Старые наборы неизменяемы:
на развёрнутых стендах seed сверяет sha256, поэтому новый голос — это новый набор, а не
перезапись файлов. Переключение меняет пути в `data/scenarios/*.json` и поднимает `version`:
выданный план неизменяем, новый голос до стенда доходит только новой версией сценария.

Раскладка: реплика с прежней озвучкой `<старый набор>/<остаток>` получает путь
`<набор>/<остаток>`; реплика без озвучки — `<набор>/<код сценария>/<ключи>.ogg`.
Голос реплики — голос службы сценария (`service_id`): у бригад сценария служба одна.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
SCENARIOS = ROOT / "data" / "scenarios"


def lines(node: Any, trail: tuple[str, ...] = ()) -> Iterator[tuple[tuple[str, ...], Any, str]]:
    """(путь ключей, контейнер, поле) каждой реплики сценария: поля `line` и `with`."""
    if isinstance(node, dict):
        name = node.get("key")
        here = trail + (name,) if isinstance(name, str) else trail
        for field, value in node.items():
            if field in ("line", "with") and value:
                yield here, node, field
            elif isinstance(value, (dict, list)):
                step = here if field in ("plan", "events", "effects") else here + (field,)
                yield from lines(value, step)
    elif isinstance(node, list):
        for item in node:
            yield from lines(item, trail)


def replies(data: dict[str, Any]) -> Iterator[tuple[tuple[str, ...], Any, str]]:
    """Реплики сценария: доклады плана и события (осложнения, уточнения бригады)."""
    yield from lines(data["plan"])
    yield from lines(data.get("events", []), ("event",))


def target(voice_set: str, code: str, trail: tuple[str, ...], line: Any) -> str:
    old = line.get("audio") if isinstance(line, dict) else None
    if old:
        return f"{voice_set}/{old.split('/', 1)[1]}"
    return f"{voice_set}/{code}/{'-'.join(trail)}.ogg"


def scenario_files() -> list[Path]:
    return sorted(SCENARIOS.glob("*.json"))


def todo(voice_set: str) -> list[dict[str, str]]:
    """Реплики всех сценариев ДДС: служба, путь в наборе, текст. Повторы путей — один раз."""
    result: dict[str, dict[str, str]] = {}
    for path in scenario_files():
        data = json.loads(path.read_text(encoding="utf-8"))
        for trail, node, field in replies(data):
            line = node[field]
            text = line if isinstance(line, str) else line["text"]
            relative = target(voice_set, data["code"], trail, line)
            known = result.get(relative)
            if known and known["text"] != text:
                raise SystemExit(f"{relative}: два разных текста ({path.name})")
            result[relative] = {"service_id": data["service_id"], "path": relative, "text": text}
    return list(result.values())


def switch(voice_set: str) -> int:
    """Перевести сценарии на набор: пути озвучки → набор, version + 1. Нужен манифест набора
    со всеми репликами — иначе сценарий ушёл бы текстом, а не новым голосом."""
    manifest_path = ROOT / "data" / "voices" / voice_set / "manifest.json"
    manifest = {
        item["path"]: item
        for item in json.loads(manifest_path.read_text(encoding="utf-8"))["messages"]
    }
    missing = [item["path"] for item in todo(voice_set) if item["path"] not in manifest]
    if missing:
        raise SystemExit(f"в {manifest_path} нет {len(missing)} реплик, например {missing[0]}")
    changed = 0
    for path in scenario_files():
        data = json.loads(path.read_text(encoding="utf-8"))
        before = json.dumps(data, ensure_ascii=False)
        for trail, node, field in replies(data):
            line = node[field]
            text = line if isinstance(line, str) else line["text"]
            node[field] = {"text": text, "audio": target(voice_set, data["code"], trail, line)}
        if json.dumps(data, ensure_ascii=False) == before:
            continue
        data["version"] += 1
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        changed += 1
    print(f"сценариев переведено на {voice_set}: {changed}")
    return 0


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] not in ("todo", "switch"):
        print(__doc__, file=sys.stderr)
        return 2
    command, voice_set = sys.argv[1:]
    if command == "todo":
        json.dump(todo(voice_set), sys.stdout, ensure_ascii=False, indent=1)
        print()
        return 0
    return switch(voice_set)


if __name__ == "__main__":
    raise SystemExit(main())
