"""Собрать 10 синтетических эталонов из утверждённых кодов классификатора."""

import copy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CASES = [
    ("2020000", "102", []),
    ("1010101", "101", ["parallel"]),
    ("12080900", "103", ["no_phone"]),
    ("13010100", "104", ["no_contact"]),
    ("14030100", "GKH", []),
    ("14100100", "MOSLIFT", ["wrong_address"]),
    ("1010101", "101", ["emergency"]),
    ("2020000", "102", ["duplicate"]),
    ("13010100", "104", []),
    ("14100100", "MOSLIFT", ["parallel"]),
]


def build() -> None:
    """Обновить сценарии в golden, сохраняя одинаковый успешный таймлайн для T-006."""
    catalog = json.loads((ROOT / "data/classifier.json").read_text(encoding="utf-8"))
    types = {item["code"]: item for item in catalog["incident_types"]}
    phones = {item["id"]: item["phone_ext"] for item in catalog["services"]}
    base = json.loads((ROOT / "data/golden_scenarios/case-01.json").read_text(encoding="utf-8"))
    for i, (code, service, complications) in enumerate(CASES):
        case = copy.deepcopy(base)
        case["id"] = f"case-{i + 1}"
        scenario = case["scenario"]
        scenario.update(
            id=f"00000000-0000-4000-8000-{100 + i:012d}",
            level=i % 4 + 1,
            weight=i + 1,
            incident_type_code=code,
            target_service_id=service,
            complications=complications,
        )
        card = scenario["card"]
        card.update(
            number=str(10000001 + i),
            incident_type_code=code,
            incident_class=types[code]["name"],
            description=(
                f"Учебное происшествие: {types[code]['name']}. Москва, Дубнинская улица, дом 1."
            ),
            service_ids=[service],
            tags=[types[code]["sign1"]],
            emergency="emergency" in complications,
            phone_aon="" if "no_phone" in complications else "+79000000001",
        )
        if "wrong_address" in complications:
            card["address"]["street"] = "Дубининская улица"
        reference = scenario["reference"]
        reference.update(
            expected_service_ids=[service],
            expected_comment=(
                f"В службу {service} передана информация: {types[code]['name']}. "
                "Москва, Дубнинская улица, дом 1. Направлен экипаж."
            ),
        )
        reference["expected_call"].update(service_id=service, phone_ext=phones[service])
        case["current"]["comment"] = reference["expected_comment"]
        call_id = f"00000000-0000-4000-8000-{600 + i:012d}"
        for j, event in enumerate(case["events"]):
            event["client_event_id"] = f"00000000-0000-4000-8000-{1000 + i * 20 + j:012d}"
            if "call_id" in event["payload"]:
                event["payload"]["call_id"] = call_id
            if "phone_ext" in event["payload"]:
                event["payload"]["phone_ext"] = phones[service]
            if "comment" in event["payload"]:
                event["payload"]["comment"] = reference["expected_comment"]
        case["calls"][0].update(id=call_id, service_id=service, phone_ext=phones[service])
        (ROOT / f"data/golden_scenarios/case-{i + 1:02d}.json").write_text(
            json.dumps(case, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )


if __name__ == "__main__":
    build()
