"""Поставить в сценарии фразы банка, которые ждали записи (placements.json рядом).

    python3 scripts/voices/bank/place.py            # поставить всё, что уже записано
    python3 scripts/voices/bank/place.py --dry-run  # только показать

Фразу пишут заранее, а в сценарий она попадает только с записью: реплика без записи звучала
бы текстом (решение капитана 18.10, HQ-055). Запись ищется в манифестах наборов
`data/voices/bank-v*` по id фразы, текст в манифесте должен совпасть с книгой. Для каждой
записанной фразы скрипт:

- меняет реплику доклада `report`, если её текст всё ещё `was` (иначе — ошибка: сценарий
  правили, план надо сверить руками);
- при `event` и `branches` — не трогает сам доклад, а добавляет веткам события подмену
  доклада (`replace`) этой фразой;
- поднимает `version` сценария (один раз на сценарий) и убирает запись из плана.

Дальше — тесты затронутого и прогон связности по этим сценариям (docs/coherence_night.md).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
PLAN = HERE / "placements.json"
SCENARIOS = ROOT / "data" / "scenarios"
VOICES = ROOT / "data" / "voices"


def dump(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def bank_texts() -> dict[str, str]:
    """Id фразы → текст по книгам phrases/."""
    return {
        phrase["id"]: phrase["text"]
        for path in sorted((HERE / "phrases").glob("*.json"))
        for phrase in json.loads(path.read_text(encoding="utf-8"))["phrases"]
    }


def recordings() -> dict[str, dict[str, str]]:
    """Id фразы → запись (path, text) из манифестов наборов bank-v*; новый набор главнее."""
    found: dict[str, dict[str, str]] = {}
    folders = sorted(VOICES.glob("bank-v*"), key=lambda path: int(path.name[len("bank-v") :]))
    for folder in folders:
        manifest = folder / "manifest.json"
        if manifest.exists():
            for item in json.loads(manifest.read_text(encoding="utf-8"))["messages"]:
                found[item["id"]] = item
    return found


def place(data: dict[str, Any], item: dict[str, Any], line: dict[str, str]) -> None:
    """Поставить реплику `line` в сценарий `data` по записи плана `item` (на месте)."""
    report = next(report for report in data["plan"] if report["key"] == item["report"])
    current = report["line"] if isinstance(report["line"], str) else report["line"]["text"]
    if current != item["was"]:
        raise SystemExit(
            f"{item['scenario']} {item['report']}: реплика «{current}», а план ждёт "
            f"«{item['was']}» — сверьте placements.json"
        )
    if "event" not in item:
        report["line"] = dict(line)
        return
    event = next(event for event in data["events"] if event["key"] == item["event"])
    for name in item["branches"]:
        effects = event["branches"][name]["effects"]
        effects[:] = [effect for effect in effects if effect.get("replace") != item["report"]]
        effects.append({"replace": item["report"], "with": dict(line)})


def main(argv: list[str]) -> int:
    dry = "--dry-run" in argv
    plan = json.loads(PLAN.read_text(encoding="utf-8"))
    texts, voiced = bank_texts(), recordings()
    left: list[dict[str, Any]] = []
    touched: dict[str, dict[str, Any]] = {}
    for item in plan["placements"]:
        phrase = item["phrase"]
        record = voiced.get(phrase)
        if record is None:
            print(f"ждёт записи: {phrase} → {item['scenario']} {item['report']}")
            left.append(item)
            continue
        if record["text"] != texts[phrase]:
            raise SystemExit(f"{phrase}: текст записи {record['path']} не совпадает с книгой")
        code = item["scenario"]
        data = touched.get(code) or json.loads(
            (SCENARIOS / f"{code}.json").read_text(encoding="utf-8")
        )
        place(data, item, {"text": record["text"], "audio": record["path"]})
        touched[code] = data
        print(f"ставлю: {phrase} ({record['path']}) → {code} {item['report']}")
    if dry or not touched:
        return 0
    for code, data in touched.items():
        data["version"] += 1
        dump(SCENARIOS / f"{code}.json", data)
    dump(PLAN, {**plan, "placements": left})
    print(f"сценариев: {len(touched)}, версии подняты; осталось в плане: {len(left)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
