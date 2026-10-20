"""Записи оператора-бота для связки 112 → ДДС, шаг 1 (contracts/link-112-dds.md).

python -m app.tools.build_link112_records; записывает только data/link112/records.
Карточки раздаёт seed (app.seed.link112): каждая запись — сценарий ДДС для службы 101.

- `correct` — оператор записал всё верно;
- `wrong-street` — к демо: «Дубининская» вместо «Дубнинской», газ не отмечен (служба 104
  карточку не получает), уровень 1;
- `wrong-street-level2` — та же ловушка улиц при отмеченном газе, уровень 2 (осложнение).
"""

import json
from copy import deepcopy
from typing import Any

from app.core.config import ROOT
from app.operator.router import CardInput
from app.operator.scenarios import load_scenarios

WRONG_STREET = "Дубининская улица"


def _card(fields: dict[str, Any]) -> dict[str, Any]:
    """Ввод оператора в форме CardInput — как в теле POST /api/operator/save."""
    return CardInput.model_validate(fields).model_dump()


def build_records() -> list[dict[str, Any]]:
    scenario = next(item for item in load_scenarios() if item["id"] == "fire_apartment_smoke")
    truth = {
        "incident_type_code": scenario["incident_type_code"],
        "tags": scenario["expected_tags"],
        "services": scenario["expected_services"],
        "address": scenario["address"],
        "description": scenario["description_reference"],
        "caller_name": scenario["caller"]["name"],
        "caller_status": scenario["caller"]["status"],
        "phone_provided": scenario["caller"]["phone"],
        "phone_scene": scenario["caller"]["phone"],
    }
    correct: dict[str, Any] = {
        "id": "fire_apartment_smoke.correct",
        "title": "Пожар: оператор записал адрес верно",
        "operator_scenario_id": scenario["id"],
        "level": 1,
        "elapsed_s": 90,
        "card": _card(truth),
        "teacher_note": "Карточка соответствует словам заявителя.",
    }
    # Запись к демо (DT-04): две ошибки оператора, номер карточки 10271704 — от этого id.
    demo: dict[str, Any] = {
        "id": "fire_apartment_smoke.wrong-street",
        "title": "Дым в квартире: улица записана с ошибкой, газ не отмечен",
        "operator_scenario_id": scenario["id"],
        "level": 1,
        "elapsed_s": 140,
        "card": _card(
            {
                "incident_type_code": scenario["incident_type_code"],
                "tags": ["victims"],
                "services": [item for item in scenario["expected_services"] if item != "104"],
                # Остальной адрес — как сказал заявитель: ошибок в записи ровно две.
                "address": {**scenario["address"], "street": WRONG_STREET},
                "description": (
                    "Задымление в квартире 47 на пятом этаже, из-под двери идёт дым, огня не "
                    "видно. В квартире пожилая соседка, на стук не открывает."
                ),
                "caller_name": scenario["caller"]["name"],
            }
        ),
        "teacher_note": (
            "Две ошибки оператора: «Дубининская» вместо «Дубнинской» (бригады едут не туда) "
            "и не отмечена газификация — служба 104 карточку не получает."
        ),
    }
    level2 = deepcopy(correct)
    level2["id"] = "fire_apartment_smoke.wrong-street-level2"
    level2["title"] = "Пожар, осложнение: оператор перепутал Дубнинскую и Дубининскую"
    level2["level"] = 2
    level2["card"]["address"]["street"] = WRONG_STREET
    level2["teacher_note"] = (
        "В карточке Дубининская; по сюжету пожар на Дубнинской. "
        "Ошибка оператора не должна снижать оценку ДДС."
    )
    return [correct, demo, level2]


if __name__ == "__main__":
    target = ROOT / "data/link112/records"
    target.mkdir(parents=True, exist_ok=True)
    for record in build_records():
        (target / f"{record['id']}.json").write_text(
            json.dumps(record, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
