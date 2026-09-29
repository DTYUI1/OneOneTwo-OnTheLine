"""Сценарии самостоятельной тренировки (29.09): семь происшествий, по варианту на службу.

Тренировка ступеней 2–3 берёт случайный одобренный сценарий своей службы. Обычные
сценарии (golden, билеты) учебного плана не имеют: бригада на них молчит, и у обучаемого
«ничего не происходит». Здесь — готовые происшествия из `data/practice/*.json`: для каждой
службы карточки два сценария.

- Уровень 1 (ступень 2): полный цикл — выезд, прибытие, работы, завершение.
- Уровень 2 (ступень 3): осложнение — после прибытия бригада докладывает, что работы не
  проводились, и называет причину («Отказ от выполнения работ», памятка ДДС, стр. 22).
  Служба 103 отказ не ставит — у неё «Работы завершены» (памятка, стр. 23).

Каждый доклад ждёт статуса диспетчера (requires_state), как в обучающем упражнении.
Голос — `data/voices/practice/manifest.json` (Piper, голос службы); доклада нет в манифесте
или текст в нём другой — доклад уходит текстом, диспетчер подтверждает прочтение.
Повторный запуск ничего не меняет: UUID стабильны, существующие сценарии не трогаются.
"""

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.training.audio import register_asset
from app.api.training.content import store_plan
from app.core.config import ROOT
from app.core.models import Scenario, Service, User

logger = logging.getLogger(__name__)

PRACTICE_DIR = ROOT / "data" / "practice"
AUDIO_MANIFEST = Path("practice") / "manifest.json"

FULL_FLOW = ["received", "accepted", "responding", "arrived", "working", "completed"]
# Отказ от выполнения работ: реагирование начато, работы на месте не проводились.
COMPLICATION_FLOW = ["received", "accepted", "responding", "arrived"]

# Бригада докладывает через несколько секунд после нужного статуса: учим порядку, а не ждать.
AFTER_S = {"departure": 3, "arrival": 6, "works": 6, "completion": 6, "outcome": 6}


@dataclass(frozen=True)
class Stage:
    """Доклад плана: имя этапа, статус, которого он ждёт, и статус, который он обосновывает."""

    name: str
    requires: str
    justifies: str
    text: str


def scenario_id(key: str, service_id: str, level: int) -> UUID:
    return uuid5(NAMESPACE_URL, f"arm112:practice:{key}:{service_id}:{level}")


def audio_path(key: str, service_id: str, level: int, stage: str) -> str:
    """Путь относительно data/voices; выезд одинаков для обоих уровней."""
    name = stage if stage == "departure" else f"{stage}-{level}"
    return f"practice/{key}/{service_id}/{name}.ogg"


def load_incidents(directory: Path = PRACTICE_DIR) -> list[dict[str, Any]]:
    incidents = [
        json.loads(path.read_text(encoding="utf-8")) for path in sorted(directory.glob("*.json"))
    ]
    return sorted(incidents, key=lambda item: item["order"])


def stages(variant: dict[str, Any], level: int) -> list[Stage]:
    departure = Stage("departure", "accepted", "responding", variant["departure"])
    if level == 1:
        full = variant["full"]
        return [
            departure,
            Stage("arrival", "responding", "arrived", full["arrival"]),
            Stage("works", "arrived", "working", full["works"]),
            Stage("completion", "working", "completed", full["completion"]),
        ]
    complication = variant["complication"]
    return [
        departure,
        Stage("arrival", "responding", "arrived", complication["arrival"]),
        Stage("outcome", "arrived", complication["state"], complication["outcome"]),
    ]


def expected_flow(variant: dict[str, Any], level: int) -> list[str]:
    if level == 1:
        return list(FULL_FLOW)
    return [*COMPLICATION_FLOW, variant["complication"]["state"]]


def variants(incident: dict[str, Any]) -> list[tuple[str, int]]:
    """(служба, уровень) всех сценариев происшествия."""
    return [(service_id, level) for service_id in incident["services"] for level in (1, 2)]


def card_number(incident: dict[str, Any], service_index: int, level: int) -> str:
    return f"70005{incident['order']}{service_index}{level}"


def _load_audio(audio_dir: Path) -> dict[str, dict[str, Any]]:
    path = audio_dir / AUDIO_MANIFEST
    if not path.exists():
        return {}
    manifest = json.loads(path.read_text(encoding="utf-8"))
    return {item["path"]: item for item in manifest["messages"]}


async def _audio(
    db: AsyncSession,
    audio_dir: Path,
    manifest: dict[str, dict[str, Any]],
    relative_path: str,
    text: str,
) -> dict[str, Any] | None:
    """Озвучка доклада или None — тогда доклад текстовый."""
    item = manifest.get(relative_path)
    if item is None or item["text"] != text or not (audio_dir / relative_path).exists():
        return None
    asset_id = uuid5(NAMESPACE_URL, f"arm112:practice:audio:{relative_path}")
    asset = await register_asset(
        db,
        audio_dir,
        asset_id=asset_id,
        version=1,
        relative_path=relative_path,
        duration_ms=item["duration_ms"],
        media_type=item["media_type"],
    )
    if asset.sha256 != item["sha256"]:
        raise RuntimeError(f"Аудио {relative_path} не совпадает с манифестом.")
    return {
        "asset_id": str(asset_id),
        "version": 1,
        "sha256": asset.sha256,
        "url": f"/api/materials/{asset_id}/content?version=1",
        "duration_ms": item["duration_ms"],
    }


def scenario_payload(
    incident: dict[str, Any], service_id: str, level: int, phone_ext: str
) -> dict[str, Any]:
    """Сценарий по контракту scenario.schema.json (без автора): карточка, эталон, уровень."""
    variant = incident["services"][service_id]
    outcome = stages(variant, level)[-1].text
    return {
        "id": str(scenario_id(incident["key"], service_id, level)),
        "version": 1,
        "level": level,
        "weight": 1,
        "incident_type_code": incident["incident_type_code"],
        "target_service_id": service_id,
        "card": {
            **incident["card"],
            "number": card_number(incident, list(incident["services"]).index(service_id), level),
            "incident_type_code": incident["incident_type_code"],
        },
        "reference": {
            "expected_flow": expected_flow(variant, level),
            "required_fields": ["service_number", "comment"],
            "expected_service_ids": [service_id],
            "expected_address": dict(incident["card"]["address"]),
            "expected_call": {
                "required": True,
                "service_id": service_id,
                "phone_ext": phone_ext,
                "before_s": 180,
            },
            "expected_comment": f"{incident['card']['description']} {outcome}",
        },
        "complications": [],
        "origin": "template",
        "status": "approved",
        "teacher_comment": (
            f"Тренировка без преподавателя: {incident['title'].lower()}. "
            + (
                "Полный цикл: бригада докладывает о выезде, прибытии, работах и завершении"
                if level == 1
                else "Осложнение: после прибытия бригада докладывает, что работы не "
                "проводились, и называет причину"
            )
            + " — каждый доклад после статуса диспетчера."
        ),
    }


async def seed_practice(
    db: AsyncSession, audio_dir: Path, directory: Path = PRACTICE_DIR
) -> list[Scenario]:
    """Сценарии тренировки; нужны seed_catalog (бригады) и преподаватель teacher."""
    teacher = await db.scalar(select(User).where(User.login == "teacher"))
    if teacher is None:
        raise RuntimeError("Сначала выполните основной seed: нужен преподаватель teacher.")
    services = {item.id: item for item in await db.scalars(select(Service))}
    manifest = _load_audio(audio_dir)
    created: list[Scenario] = []
    silent = 0
    for incident in load_incidents(directory):
        for service_id, level in variants(incident):
            service = services.get(service_id)
            if service is None:
                continue
            scenario_uuid = scenario_id(incident["key"], service_id, level)
            existing = await db.get(Scenario, scenario_uuid)
            if existing is not None:
                created.append(existing)
                continue
            payload = scenario_payload(incident, service_id, level, service.phone_ext)
            scenario = Scenario(**{**payload, "id": scenario_uuid}, author_id=teacher.id)
            plan_stages = stages(incident["services"][service_id], level)
            db.add(scenario)
            await db.flush()
            brigade_id = uuid5(NAMESPACE_URL, f"arm112:c04:{service_id}:brigade:0")
            target_id = uuid5(NAMESPACE_URL, f"arm112:c04:{service_id}:target:0")
            messages = []
            for stage in plan_stages:
                audio = await _audio(
                    db,
                    audio_dir,
                    manifest,
                    audio_path(incident["key"], service_id, level, stage.name),
                    stage.text,
                )
                silent += audio is None
                messages.append(
                    {
                        "message": {
                            "id": str(uuid5(scenario_uuid, f"message:{stage.name}")),
                            "version": 1,
                            "text": stage.text,
                            "audio": audio,
                        },
                        "brigade_id": str(brigade_id),
                        "call_target_id": str(target_id),
                        "available_after_s": AFTER_S[stage.name],
                        "expected_comment": stage.text,
                        "requires_state": stage.requires,
                        "justifies_state": stage.justifies,
                    }
                )
            await store_plan(
                db,
                scenario.id,
                scenario.version,
                teacher.id,
                {
                    "version": 1,
                    "required_brigade_ids": [str(brigade_id)],
                    "messages": messages,
                    "observable_defects": [],
                },
            )
            created.append(scenario)
    if silent:
        logger.warning(
            "Сценарии тренировки: %s докладов без озвучки — уйдут текстом "
            "(data/voices/practice/manifest.json).",
            silent,
        )
    await db.flush()
    return created
