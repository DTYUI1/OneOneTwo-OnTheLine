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
«Живая бригада» (DT-10): у варианта службы может быть блок `live` — события плана
(уточнение, просьба о другой службе, молчание, тревога, повтор адреса с ошибкой) для
полного цикла.
Голос — `data/voices/practice/manifest.json` (Piper, голос службы); доклада нет в манифесте
или текст в нём другой — доклад уходит текстом, диспетчер подтверждает прочтение.

С 16.10 (GP-03) seed берёт сценарии из файлов формата 2 (`app.seed.scenarios`,
`data/scenarios`); эти происшествия переведены туда `app.seed.convert_practice` с прежними
UUID. Здесь остались правила перевода и общие помощники озвучки (их использует и связка
112 → ДДС, `app.seed.link112`).
"""

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5

from sqlalchemy.ext.asyncio import AsyncSession

from app.api.training.audio import register_asset
from app.core.config import ROOT

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


# «Живая бригада» (DT-10): события плана — только в полном цикле (уровень 1).
LIVE_LEVEL = 1


def scenario_id(key: str, service_id: str, level: int) -> UUID:
    return uuid5(NAMESPACE_URL, f"arm112:practice:{key}:{service_id}:{level}")


def audio_path(key: str, service_id: str, level: int, stage: str, root: str = "practice") -> str:
    """Путь относительно data/voices; выезд одинаков для обоих уровней. `root` — раскладка:
    `practice` или `link112` (сюжеты связки, `app.seed.link112`)."""
    name = stage if stage == "departure" else f"{stage}-{level}"
    return f"{root}/{key}/{service_id}/{name}.ogg"


def event_audio_path(
    key: str, service_id: str, event_key: str, part: str = "", root: str = "practice"
) -> str:
    """Путь озвучки реплики события относительно data/voices: `event-<событие>[-<часть>]`."""
    suffix = f"-{part}" if part else ""
    return f"{root}/{key}/{service_id}/event-{event_key}{suffix}.ogg"


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


def live(variant: dict[str, Any], level: int) -> dict[str, Any] | None:
    """Блок «живой бригады» варианта службы для уровня; None — бригада только докладывает."""
    block: dict[str, Any] | None = variant.get("live")
    return block if block is not None and level == LIVE_LEVEL else None


@dataclass(frozen=True)
class Line:
    """Реплика события до озвучки: сообщение плана и путь его аудио."""

    message: dict[str, Any]
    audio_path: str


def live_events(
    scenario_uuid: UUID,
    key: str,
    service_id: str,
    block: dict[str, Any],
    audio_root: str = "practice",
) -> tuple[list[dict[str, Any]], list[Line]]:
    """События плана (ScenarioEvent, c01.schema.json) из короткой записи в data/practice.

    В записи — ключи вместо UUID: доклады называются этапом (`arrival`, `works`,
    `completion`), события — своим `key`, реплики — текстом. Id стабильны (uuid5 от
    сценария), поэтому повторный seed даёт тот же план. Реплики возвращаются отдельно:
    озвучку подставляет seed, как у докладов; `key` и `audio_root` задают только пути
    озвучки (`event_audio_path`).
    """
    brigade_id = uuid5(NAMESPACE_URL, f"arm112:c04:{service_id}:brigade:0")
    target_id = uuid5(NAMESPACE_URL, f"arm112:c04:{service_id}:target:0")
    lines: list[Line] = []

    def message_id(stage: str) -> str:
        return str(uuid5(scenario_uuid, f"message:{stage}"))

    def event_id(event_key: str) -> str:
        return str(uuid5(scenario_uuid, f"event:{event_key}"))

    def line(text: str | None, event_key: str, part: str = "") -> dict[str, Any] | None:
        if text is None:
            return None
        name = f"event:{event_key}:{part}" if part else f"event:{event_key}"
        message = {"id": str(uuid5(scenario_uuid, name)), "version": 1, "text": text, "audio": None}
        lines.append(Line(message, event_audio_path(key, service_id, event_key, part, audio_root)))
        return message

    def trigger(raw: dict[str, Any]) -> dict[str, Any]:
        result = {k: v for k, v in raw.items() if k not in {"stage", "event"}}
        if "stage" in raw:
            result["message_id"] = message_id(raw["stage"])
        if "event" in raw:
            result["event_id"] = event_id(raw["event"])
        return result

    # Одна подмена на несколько веток («не так» и «не сделал» — расчёт приехал не туда) —
    # одна реплика и одна озвучка: по первой ветке, где она встретилась.
    replacements: dict[tuple[str, str], dict[str, Any] | None] = {}

    def effect(raw: dict[str, Any], event_key: str, branch: str) -> dict[str, Any]:
        if "delay" in raw:
            return {"delay": message_id(raw["delay"]), "by_s": raw["by_s"]}
        known = (event_key, raw["with"])
        if known not in replacements:
            replacements[known] = line(raw["with"], event_key, f"{branch}-replace")
        return {"replace": message_id(raw["replace"]), "with": replacements[known]}

    events = []
    for raw in block["events"]:
        event_key = raw["key"]
        event = {
            "id": event_id(event_key),
            "version": 1,
            "kind": raw["kind"],
            "actor": "brigade",
            "brigade_id": str(brigade_id),
            "call_target_id": str(target_id),
            "channel": "brigade_call",
            "priority": raw.get("priority", "normal"),
            "trigger": trigger(raw["trigger"]),
            "line": line(raw["line"], event_key),
            "expect": raw["expect"],
            "branches": {
                name: {
                    "line": line(branch["line"], event_key, name),
                    "effects": [effect(item, event_key, name) for item in branch["effects"]],
                }
                for name, branch in raw["branches"].items()
            },
            "review": raw["review"],
            "injectable": raw.get("injectable", False),
        }
        if "reply_options" in raw:
            event["reply_options"] = raw["reply_options"]
        events.append(event)
    return events, lines


def expected_flow(variant: dict[str, Any], level: int) -> list[str]:
    if level == 1:
        return list(FULL_FLOW)
    return [*COMPLICATION_FLOW, variant["complication"]["state"]]


def variants(incident: dict[str, Any]) -> list[tuple[str, int]]:
    """(служба, уровень) всех сценариев происшествия."""
    return [(service_id, level) for service_id in incident["services"] for level in (1, 2)]


def card_number(incident: dict[str, Any], service_index: int, level: int) -> str:
    return f"70005{incident['order']}{service_index}{level}"


def training_plan(
    scenario_uuid: UUID,
    service_id: str,
    plan_stages: list[Stage],
    audios: list[dict[str, Any] | None],
    events: list[dict[str, Any]] | None = None,
    after_s: dict[str, int] | None = None,
) -> dict[str, Any]:
    """План докладов (TrainingPlan, c01.schema.json): первая учебная бригада службы
    докладывает по этапам; каждый доклад ждёт статуса диспетчера. Нет озвучки — текстом.

    `events` — события «живой бригады» (DT-10); `after_s` — свои паузы этапов: чтобы
    бригада успела замолчать, доклад о завершении приходит позже обычного."""
    pauses = {**AFTER_S, **(after_s or {})}
    brigade_id = uuid5(NAMESPACE_URL, f"arm112:c04:{service_id}:brigade:0")
    target_id = uuid5(NAMESPACE_URL, f"arm112:c04:{service_id}:target:0")
    return {
        "version": 1,
        "required_brigade_ids": [str(brigade_id)],
        "messages": [
            {
                "message": {
                    "id": str(uuid5(scenario_uuid, f"message:{stage.name}")),
                    "version": 1,
                    "text": stage.text,
                    "audio": audio,
                },
                "brigade_id": str(brigade_id),
                "call_target_id": str(target_id),
                "available_after_s": pauses[stage.name],
                "expected_comment": stage.text,
                "requires_state": stage.requires,
                "justifies_state": stage.justifies,
            }
            for stage, audio in zip(plan_stages, audios, strict=True)
        ],
        "observable_defects": [],
        **({"events": events} if events else {}),
    }


def load_audio(audio_dir: Path, manifest: Path = AUDIO_MANIFEST) -> dict[str, dict[str, Any]]:
    """Манифест озвучки (путь → запись); нет файла — пусто, доклады уйдут текстом."""
    path = audio_dir / manifest
    if not path.exists():
        return {}
    messages = json.loads(path.read_text(encoding="utf-8"))["messages"]
    return {item["path"]: item for item in messages}


async def audio_ref(
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
            # Звонок своей службе не нужен: обязательные звонки задают события (GP-04).
            "expected_call": {
                "required": False,
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
