"""Каталог сценариев ДДС из файлов формата 2: один файл `data/scenarios/<code>.json` —
один сценарий (contracts/scenario-file.schema.json, эталон docs/dds_gameplay.md, 1.1–1.3).

В файле всё, что нужно сценарию: карточка, эталон, бригады и план докладов, события и
ветки, варианты частей, ловушки. Код достраивает только ветки просьбы о службе, которую
вызвали заранее (GP-28, `service_defaults`), а в остальном переводит ключи в
стабильные UUID (как прежние сиды тренировки: доклад — uuid5(сценарий, «message:<ключ>»))
и подставляет озвучку из манифеста. Занятие преподавателя и тренировка («Мой путь») берут
сценарии из этого каталога: тренировка отбирает по службе и уровню, копий нет.

Выданный сценарий и его план неизменяемы. Изменить сценарий — поднять `version`: у новой
версии свой UUID, прежняя снимается с выдачи (`retired`), её журналы остаются. Файл с
ошибкой seed не загружает и называет ошибку в журнале; остальные сценарии загружаются.
Повторный запуск ничего не меняет.
"""

import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5

from jsonschema import Draft202012Validator, FormatChecker
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.training.briefing import (
    moved_items,
    wrong_incident_items,
    wrong_incident_prefix_items,
)
from app.api.training.content import store_plan
from app.api.training.plan_check import REPORTED_STATES
from app.api.training.status_evidence import _STATE_LABELS
from app.core.config import ROOT
from app.core.contracts import registry
from app.core.models import Scenario, Service, User
from app.seed.card_fields import with_card_fields
from app.seed.practice import audio_ref, load_audio
from app.seed.scenario_lint import lint
from app.seed.service_defaults import with_service_defaults

logger = logging.getLogger(__name__)

SCENARIOS_DIR = ROOT / "data" / "scenarios"
SCHEMA = "https://arm112.local/contracts/scenario-file.schema.json"
# Варианты ответа, которые ожидание называет по ключу (contracts/c01.schema.json).
OPTION_ACTIONS = ("reply", "correct_readback")

AudioRef = Callable[[str, str], Awaitable[dict[str, Any] | None]]


class ScenarioFileError(ValueError):
    """Файл сценария не прошёл проверку; сообщение — по-русски, с именем файла."""


def scenario_uuid(data: dict[str, Any]) -> UUID:
    explicit = data.get("id")
    if explicit:
        return UUID(explicit)
    return uuid5(NAMESPACE_URL, f"arm112:scenario:{data['code']}:{data['version']}")


def file_scenario_id(code: str, directory: Path = SCENARIOS_DIR) -> UUID:
    """UUID текущей версии сценария из файла `<code>.json` каталога."""
    path = directory / f"{code}.json"
    return scenario_uuid(json.loads(path.read_text(encoding="utf-8")))


def superseded(data: dict[str, Any]) -> list[UUID]:
    """Сценарии, которые эта версия снимает с выдачи: прежние версии и `replaces`."""
    previous = [
        uuid5(NAMESPACE_URL, f"arm112:scenario:{data['code']}:{version}")
        for version in range(1, data["version"])
    ]
    return previous + [UUID(item) for item in data.get("replaces", [])]


def brigade_ids(service_id: str, ordinal: int) -> tuple[UUID, UUID]:
    """Учебная бригада службы и её абонент в справочнике (app/seed/training.py)."""
    return (
        uuid5(NAMESPACE_URL, f"arm112:c04:{service_id}:brigade:{ordinal}"),
        uuid5(NAMESPACE_URL, f"arm112:c04:{service_id}:target:{ordinal}"),
    )


def line_text(line: str | dict[str, Any]) -> str:
    return line if isinstance(line, str) else str(line["text"])


def line_audio(line: str | dict[str, Any]) -> str | None:
    return None if isinstance(line, str) else line.get("audio")


def problems(data: dict[str, Any], stem: str, services: set[str]) -> list[str]:
    """Ошибки сверх схемы: ссылки и полнота плана, затем связность мира (`scenario_lint`:
    этапы фраз, повтор адреса, службы, паузы, повторы); пусто — файл годен."""
    found: list[str] = []
    if data["code"] != stem:
        found.append(f"код «{data['code']}» не совпадает с именем файла «{stem}.json»")
    if data["service_id"] not in services:
        found.append(
            f"неизвестная служба «{data['service_id']}» "
            f"(есть в справочнике: {', '.join(sorted(services))})"
        )
    if data.get("id") and data["version"] != 1:
        found.append(
            "поле id — только у версии 1 прежнего сценария; у новой версии свой UUID: "
            "уберите id и перенесите его в replaces"
        )
    call = data["reference"]["expected_call"]
    # Доклад руководству по телефону ДДС (contact_role, GP-09) — тоже звонок своей службе.
    if (
        call["required"]
        and call["service_id"] == data["service_id"]
        and not call.get("contact_role")
    ):
        found.append(
            "обязательный звонок своей службе: диспетчер работает с бригадами, звонки задают "
            "события сценария — поставьте в expected_call «required»: false"
        )
    brigades = [item["key"] for item in data["brigades"]]
    reports = [item["key"] for item in data["plan"]]
    events = [item["key"] for item in data.get("events", [])]
    for name, keys in (("бригады", brigades), ("доклада", reports), ("события", events)):
        for key in sorted({key for key in keys if keys.count(key) > 1}):
            found.append(f"ключ {name} «{key}» повторяется")
    for report in data["plan"]:
        if report["brigade"] not in brigades:
            found.append(f"доклад «{report['key']}»: нет бригады «{report['brigade']}»")
    flow = [state for state in data["reference"]["expected_flow"] if state != "added"]
    if flow and flow[-1] in REPORTED_STATES:
        justified = {report["justifies_state"] for report in data["plan"]}
        missing = [state for state in flow if state in REPORTED_STATES and state not in justified]
        if missing:
            found.append(
                "нет плана до завершения: в плане нет доклада для статуса "
                + ", ".join(f"«{_STATE_LABELS[state]}»" for state in missing)
            )
    for report in data["plan"]:
        change = report.get("task_change")
        if change is None:
            continue
        where = f"доклад «{report['key']}», перемена задачи"
        new_call = change.get("expected_call")
        if (
            new_call is not None
            and new_call["required"]
            and new_call["service_id"] == data["service_id"]
            and not new_call.get("contact_role")
        ):
            found.append(f"{where}: обязательный звонок своей службе")
        new_flow = [state for state in change.get("expected_flow", []) if state != "added"]
        if new_flow and new_flow[-1] in REPORTED_STATES:
            justified = {item["justifies_state"] for item in data["plan"]}
            missing = [s for s in new_flow if s in REPORTED_STATES and s not in justified]
            if missing:
                found.append(
                    f"{where}: в плане нет доклада для статуса "
                    + ", ".join(f"«{_STATE_LABELS[state]}»" for state in missing)
                )
    for event in data.get("events", []):
        where = f"событие «{event['key']}»"
        if event.get("brigade", brigades[0]) not in brigades:
            found.append(f"{where}: нет бригады «{event['brigade']}»")
        trigger = event["trigger"]
        if "report" in trigger and trigger["report"] not in reports:
            found.append(f"{where}: триггер ссылается на неизвестный доклад «{trigger['report']}»")
        if "event" in trigger and trigger["event"] not in events:
            found.append(f"{where}: триггер ссылается на неизвестное событие «{trigger['event']}»")
        options = {item["key"] for item in event.get("reply_options", [])}
        for expect in event["expect"]:
            if expect["action"] in OPTION_ACTIONS and expect["option_key"] not in options:
                found.append(f"{where}: нет варианта ответа «{expect['option_key']}»")
        for branch in event["branches"].values():
            awaits = branch.get("awaits_call", {})
            required = awaits.get("required_facts", [])
            if required:
                from app.api.training.caller import caller_phrases, tells_fact

                plot = data.get("caller", {}).get("plot")
                facts = {
                    key
                    for phrase in caller_phrases().values()
                    if plot in phrase.get("incidents", []) and tells_fact(phrase)
                    for key in phrase.get("tells", [])
                }
                if awaits["contact_role"] != "caller" or not set(required) <= facts:
                    found.append(f"{where}: ожидание ссылается на неизвестные сведения заявителя")
            relay_key = awaits.get("relay_event")
            if relay_key:
                relay = next((item for item in data["events"] if item["key"] == relay_key), None)
                if (
                    relay is None
                    or relay is event
                    or not required
                    or relay.get("brigade", brigades[0]) != event.get("brigade", brigades[0])
                ):
                    found.append(f"{where}: передача сведений — событие той же бригады этого плана")
            for effect in branch["effects"]:
                target = effect.get("delay") or effect.get("replace")
                if target not in reports:
                    found.append(f"{where}: последствие для неизвестного доклада «{target}»")
    for trap in data.get("traps", []):
        if trap not in events:
            found.append(f"ловушка «{trap}»: нет такого события")
    for step, options in data.get("input_parts", {}).items():
        if sum(item["correct"] for item in options) != 1:
            found.append(f"варианты частей «{step}»: нужен ровно один верный")
    control_keys = [item["key"] for item in data.get("control_call", {}).get("reply_options", [])]
    for key in sorted({key for key in control_keys if control_keys.count(key) > 1}):
        found.append(f"звонок отдела контроля: ключ варианта «{key}» повторяется")
    # Связность мира (`scenario_lint`) — когда ссылки файла целы: иначе проверять нечего.
    if not found:
        found.extend(lint(data))
    return found


def read_file(path: Path, services: set[str]) -> dict[str, Any]:
    """Файл сценария после проверки схемой и связности; иначе ScenarioFileError."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ScenarioFileError(f"{path.name}: не JSON — {error}") from error
    return validate(data, path.stem, services, path.name)


def validate(data: Any, stem: str, services: set[str], name: str | None = None) -> dict[str, Any]:
    """Сценарий-словарь после проверки схемой и связности (как файл каталога); иначе
    ScenarioFileError. `stem` — имя файла без `.json` (у сценария из кода — его код)."""
    name = name or f"{stem}.json"
    validator = Draft202012Validator(
        {"$ref": SCHEMA}, registry=registry(), format_checker=FormatChecker()
    )
    errors = sorted(validator.iter_errors(data), key=lambda item: list(item.absolute_path))
    if errors:
        details = "; ".join(
            f"{'/'.join(str(part) for part in error.absolute_path) or 'файл'}: {error.message}"
            for error in errors[:5]
        )
        raise ScenarioFileError(f"{name}: не по схеме scenario-file.schema.json — {details}")
    found = problems(data, stem, services)
    if found:
        raise ScenarioFileError(f"{name}: " + "; ".join(found))
    return dict(data)


@dataclass(frozen=True)
class Catalog:
    scenarios: list[dict[str, Any]]
    rejected: list[str]


def load_catalog(services: set[str], directory: Path = SCENARIOS_DIR) -> Catalog:
    """Все файлы каталога: годные — в `scenarios`, сообщения об ошибках — в `rejected`."""
    scenarios, rejected = [], []
    for path in sorted(directory.glob("*.json")):
        try:
            scenarios.append(read_file(path, services))
        except ScenarioFileError as error:
            rejected.append(str(error))
    return Catalog(scenarios, rejected)


def scenario_row(data: dict[str, Any]) -> dict[str, Any]:
    """Сценарий по контракту scenario.schema.json (без автора)."""
    return {
        "id": scenario_uuid(data),
        "version": data["version"],
        "level": data["level"],
        "weight": data["weight"],
        "incident_type_code": data["incident_type_code"],
        "target_service_id": data["service_id"],
        "card": data["card"],
        "reference": data["reference"],
        "complications": data["complications"],
        "origin": "template",
        "status": "approved",
        "teacher_comment": data["teacher_comment"],
    }


async def training_plan(data: dict[str, Any], audio: AudioRef) -> dict[str, Any]:
    """План (TrainingPlan, c01.schema.json) из файла: ключи → UUID, озвучка — из `audio`.

    Просьбам о службе загрузчик достраивает ветки «служба вызвана заранее» и варианты ответа,
    если их нет в файле (GP-28, `service_defaults.with_service_defaults`). В подписи вариантов
    ответа подставляются поля карточки (`{caller_phone}`, `card_fields.with_card_fields`).
    """
    data = with_card_fields(with_service_defaults(data))
    sid = scenario_uuid(data)
    service_id = data["service_id"]
    crew = {item["key"]: brigade_ids(service_id, item["ordinal"]) for item in data["brigades"]}
    first = data["brigades"][0]["key"]

    def message_id(key: str) -> str:
        return str(uuid5(sid, f"message:{key}"))

    def event_id(key: str) -> str:
        return str(uuid5(sid, f"event:{key}"))

    async def message(raw: str | dict[str, Any], name: str) -> dict[str, Any]:
        text = line_text(raw)
        path = line_audio(raw)
        return {
            "id": str(uuid5(sid, name)),
            "version": 1,
            "text": text,
            "audio": await audio(path, text) if path else None,
        }

    messages = []
    for report in data["plan"]:
        brigade, target = crew[report["brigade"]]
        planned = {
            "message": await message(report["line"], f"message:{report['key']}"),
            "brigade_id": str(brigade),
            "call_target_id": str(target),
            "available_after_s": report["after_s"],
            "expected_comment": report.get("expected_comment", line_text(report["line"])),
            "requires_state": report["requires_state"],
            "justifies_state": report["justifies_state"],
        }
        # Доклад с места меняет задачу (TC-05): после него эталон оценки карточки другой.
        if "task_change" in report:
            planned["task_change"] = report["task_change"]
        messages.append(planned)

    events = []
    for raw in data.get("events", []):
        key = raw["key"]
        brigade, target = crew[raw.get("brigade", first)]
        trigger = {k: v for k, v in raw["trigger"].items() if k not in {"report", "event"}}
        if "report" in raw["trigger"]:
            trigger["message_id"] = message_id(raw["trigger"]["report"])
        if "event" in raw["trigger"]:
            trigger["event_id"] = event_id(raw["trigger"]["event"])
        # Одна подмена на несколько веток — одна реплика: по первой ветке, где встретилась.
        replacements: dict[str, dict[str, Any]] = {}
        branches = {}

        async def convert_effects(
            items: list[dict[str, Any]],
            name: str,
            key: str = key,
            replacements: dict[str, dict[str, Any]] = replacements,
        ) -> list[dict[str, Any]]:
            effects = []
            for item in items:
                if "delay" in item:
                    effects.append({"delay": message_id(item["delay"]), "by_s": item["by_s"]})
                    continue
                text = line_text(item["with"])
                if text not in replacements:
                    replacements[text] = await message(item["with"], f"event:{key}:{name}-replace")
                effects.append({"replace": message_id(item["replace"]), "with": replacements[text]})
            return effects

        for name, branch in raw["branches"].items():
            line = branch["line"]
            branches[name] = {
                "line": await message(line, f"event:{key}:{name}") if line is not None else None,
                "effects": await convert_effects(branch["effects"], name),
            }
            # Ветка ждёт звонка абоненту (HQ-019): её последствия «не дождались» — те же
            # подмены и задержки, что у обычных веток.
            awaits = branch.get("awaits_call")
            if awaits is not None:
                branches[name]["awaits_call"] = {
                    "contact_role": awaits["contact_role"],
                    "within_s": awaits["within_s"],
                    "otherwise": await convert_effects(awaits["otherwise"], f"{name}-no-call"),
                    **(
                        {"required_facts": awaits["required_facts"]}
                        if "required_facts" in awaits
                        else {}
                    ),
                    **(
                        {"relay_event": event_id(awaits["relay_event"])}
                        if "relay_event" in awaits
                        else {}
                    ),
                }
        event = {
            "id": event_id(key),
            "version": 1,
            "kind": raw["kind"],
            "actor": "brigade",
            "brigade_id": str(brigade),
            "call_target_id": str(target),
            "channel": "brigade_call",
            "priority": raw.get("priority", "normal"),
            "trigger": trigger,
            "line": await message(raw["line"], f"event:{key}") if raw["line"] is not None else None,
            "expect": raw["expect"],
            "branches": branches,
            "review": raw["review"],
            "injectable": raw.get("injectable", False),
        }
        if "reply_options" in raw:
            event["reply_options"] = raw["reply_options"]
        events.append(event)

    return {
        "version": 1,
        "required_brigade_ids": [str(brigade) for brigade, _ in crew.values()],
        "messages": messages,
        "observable_defects": [],
        **({"events": events} if events else {}),
        # Звонок отдела контроля при карточке без статуса (TC-07) — как в файле.
        **({"control_call": data["control_call"]} if "control_call" in data else {}),
        # Исход для разбора «Что было дальше» (GP-27) — как в файле.
        **({"outcome": data["outcome"]} if "outcome" in data else {}),
        # Живой заявитель (HQ-019): характер по умолчанию — спокойная.
        **({"caller": {"character": "calm", **data["caller"]}} if "caller" in data else {}),
    }


class AudioRefs:
    """Озвучка реплик из манифестов `data/voices` (манифест читается один раз)."""

    def __init__(self, db: AsyncSession, audio_dir: Path) -> None:
        self.db, self.audio_dir = db, audio_dir
        self.manifests: dict[str, dict[str, dict[str, Any]]] = {}
        self.silent = 0

    async def __call__(self, path: str, text: str) -> dict[str, Any] | None:
        root = path.split("/", 1)[0]
        if root not in self.manifests:
            self.manifests[root] = load_audio(self.audio_dir, Path(root) / "manifest.json")
        ref = await audio_ref(self.db, self.audio_dir, self.manifests[root], path, text)
        self.silent += ref is None
        return ref


def audio_resolver(db: AsyncSession, audio_dir: Path) -> tuple[AudioRef, list[int]]:
    """Озвучка реплик по манифестам data/voices и счётчик реплик без неё (уйдут текстом)."""
    manifests: dict[str, dict[str, dict[str, Any]]] = {}
    silent = [0]

    async def audio(path: str, text: str) -> dict[str, Any] | None:
        root = path.split("/", 1)[0]
        if root not in manifests:
            manifests[root] = load_audio(audio_dir, Path(root) / "manifest.json")
        ref = await audio_ref(db, audio_dir, manifests[root], path, text)
        silent[0] += ref is None
        return ref

    return audio, silent


async def store_scenario(
    db: AsyncSession,
    data: dict[str, Any],
    audio: AudioRef,
    *,
    plan_author_id: UUID,
    author_id: UUID | None,
    status: str = "approved",
    origin: str = "template",
) -> Scenario:
    """Записать сценарий из файла формата 2 и его учебный план.

    План задаёт преподаватель (`store_plan`); у сгенерированного сценария автора нет
    (`author_id` = None), план записывается от имени преподавателя стенда.
    """
    row = {**scenario_row(data), "status": status, "origin": origin}
    scenario = Scenario(**row, author_id=author_id)
    db.add(scenario)
    await db.flush()
    plan = await training_plan(data, audio)
    await store_plan(db, scenario.id, scenario.version, plan_author_id, plan)
    return scenario


async def seed_scenarios(
    db: AsyncSession, audio_dir: Path, directory: Path = SCENARIOS_DIR
) -> list[Scenario]:
    """Каталог сценариев из файлов; нужны seed_catalog (бригады) и преподаватель teacher."""
    teacher = await db.scalar(select(User).where(User.login == "teacher"))
    if teacher is None:
        raise RuntimeError("Сначала выполните основной seed: нужен преподаватель teacher.")
    services = set(await db.scalars(select(Service.id)))
    catalog = load_catalog(services, directory)
    for message in catalog.rejected:
        logger.error("Сценарий не загружен: %s", message)
    audio, silent = audio_resolver(db, audio_dir)

    loaded: list[Scenario] = []
    for data in catalog.scenarios:
        row = scenario_row(data)
        for old_id in superseded(data):
            old = await db.get(Scenario, old_id)
            if old is not None and old.id != row["id"] and old.status == "approved":
                old.status = "retired"
        existing = await db.get(Scenario, row["id"])
        if existing is not None:
            if existing.card != row["card"] or existing.reference != row["reference"]:
                logger.warning(
                    "Сценарий %s изменён без новой версии: выданный не переписывается, "
                    "поднимите version в data/scenarios/%s.json.",
                    data["code"],
                    data["code"],
                )
            loaded.append(existing)
            continue
        loaded.append(
            await store_scenario(db, data, audio, plan_author_id=teacher.id, author_id=teacher.id)
        )
    if silent[0]:
        logger.warning("Сценарии ДДС: %s реплик без озвучки — уйдут текстом.", silent[0])
    await seed_moved_audio(db, audio_dir)
    await db.flush()
    return loaded


async def seed_moved_audio(db: AsyncSession, audio_dir: Path) -> None:
    """Регистрация записей прибытия, в том числе после неверной вводной."""
    items = [
        *moved_items().values(),
        *wrong_incident_prefix_items().values(),
        *wrong_incident_items().values(),
    ]
    for item in items:
        service = item["service_id"]
        root = item["path"].split("/", 1)[0]
        manifest = load_audio(audio_dir, Path(root) / "manifest.json")
        if await audio_ref(db, audio_dir, manifest, item["path"], item["text"]) is None:
            logger.warning("Сценарии ДДС: нет записи прибытия после неверного адреса, %s.", service)
