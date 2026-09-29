"""Generate three reviewable synthetic draft bundles without touching the database."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from evalcore.scenario import ScenarioGenerator

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data/generated_packs"
TYPES = (
    ("2020000", "102"),
    ("1010101", "101"),
    ("12080900", "103"),
    ("13010100", "104"),
    ("14030100", "GKH"),
    ("14100100", "MOSLIFT"),
)
COMPLICATIONS: tuple[list[str], ...] = (
    [],
    ["duplicate"],
    ["no_phone"],
    ["no_contact"],
    ["emergency"],
    ["wrong_address"],
    ["parallel"],
    [],
    ["duplicate", "no_phone"],
    [],
)


def bundles() -> dict[str, dict]:
    classifier = json.loads((ROOT / "data/classifier.json").read_text(encoding="utf-8"))
    address = json.loads((ROOT / "data/templates/traffic.json").read_text(encoding="utf-8"))[
        "card"
    ]["address"]
    generator = ScenarioGenerator(classifier)
    result = {}
    for pack_no in range(1, 4):
        previews = []
        for index in range(10):
            code, service = TYPES[(index + pack_no - 1) % len(TYPES)]
            constructor = {
                "incident_type_code": code,
                "target_service_id": service,
                "address": address,
                "victims": code == "2020000" or index in (3, 8),
                "complications": COMPLICATIONS[(index + pack_no - 1) % len(COMPLICATIONS)],
                "level": (index + pack_no - 1) % 4 + 1,
                "weight": (index + pack_no - 1) % 10 + 1,
                "seed": pack_no * 10_000 + index,
            }
            previews.append(generator(constructor))
        result[f"pack-{pack_no:02d}.json"] = {
            "id": f"c05-synthetic-{pack_no:02d}",
            "title": f"C-05 синтетический пакет {pack_no}",
            "status": "draft",
            "source": "classifier 046_24 + synthetic template address; not official tickets",
            "previews": previews,
        }
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail when committed bundles differ")
    args = parser.parse_args()
    expected = {
        name: json.dumps(bundle, ensure_ascii=False, indent=2) + "\n"
        for name, bundle in bundles().items()
    }
    if args.check:
        stale = [
            name
            for name, content in expected.items()
            if not (OUTPUT / name).exists()
            or (OUTPUT / name).read_text(encoding="utf-8") != content
        ]
        if stale:
            print("Stale C-05 bundles: " + ", ".join(stale))
            return 1
        print("C-05 bundles are current")
        return 0
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for name, content in expected.items():
        (OUTPUT / name).write_text(content, encoding="utf-8")
    print(f"Wrote {len(expected)} draft bundles to {OUTPUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
