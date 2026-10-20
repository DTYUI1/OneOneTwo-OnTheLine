"""Связка «Оператор 112» → диспетчер ДДС, шаг 1: оператор-бот (contracts/link-112-dds.md).

Готовая запись оператора (`data/link112/records/*.json`) — карточка 112 в форме ввода
оператора поверх его сценария (правда сюжета). Из неё строится передача: карточка 112
(`card_for_dispatch`, как у сохранённой попытки), ошибки оператора (`operator_faults`) и
выдача по службам. Каждой службе карточки, для которой у сюжета есть доклады бригады
(`data/link112/plots/<сценарий оператора>.json`), — обычный сценарий ДДС с планом докладов,
как в тренировке (`app.seed.practice`).

Принцип: диспетчер работает с карточкой такой, как её заполнил оператор; бригада живёт по
правде сюжета; эталон — то, что диспетчер мог знать из карточки и докладов. Если ошибка
адреса уводит бригаду, она докладывает уточнённый адрес — диспетчер пишет его в комментарий
(решение 04.10: поле адреса у ДДС не редактируется), эталонный адрес — правда.

Голос — записи банка озвучки (наборы `data/voices/bank-v*`, голос службы бригады; проверка
17.10: без Piper). Запись реплики — фраза банка той же службы с тем же текстом: книги службы
и `scripts/voices/bank/link112/` (реплики сюжетов связки). Записи нет — реплика уходит
текстом: такую диспетчер засчитывает только кнопкой «Принял», а озвученная проигрывается и
засчитывается сама. Прежняя озвучка Piper (`data/voices/link112`) не используется; планы
сценариев, уже загруженных с ней, неизменны.

Где диспетчер получает карточку: преподаватель назначает такой сценарий в занятии. В случайный
выбор ступеней тренировки сценарии связки не попадают (`is_link_scenario`). Повторный запуск
ничего не меняет: UUID стабильны, существующие сценарии не трогаются.
"""

import json
import logging
import re
from collections.abc import Mapping
from dataclasses import dataclass, replace
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal
from uuid import NAMESPACE_URL, UUID, uuid5

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.training.content import store_plan
from app.core.config import ROOT
from app.core.models import Scenario, Service, User
from app.operator.faults import Fault, operator_faults, sends_to_wrong_place
from app.operator.router import CardInput, card_for_dispatch
from app.operator.scenarios import load_scenarios
from app.seed.practice import (
    Line,
    Stage,
    audio_ref,
    expected_flow,
    live,
    live_events,
    stages,
    training_plan,
)

logger = logging.getLogger(__name__)

LINK_DIR = ROOT / "data" / "link112"
# Прежняя раскладка озвучки Piper в data/voices: `live_events` по-прежнему строит по ней
# `Line.audio_path`, но голос реплик — записи банка (`bank_records`), пути не используются.
AUDIO_ROOT = "link112"

DeliveryStatus = Literal["delivered", "not_delivered", "no_plot"]

# Поля эталонного адреса сценария ДДС (scenario.schema.json, reference.expected_address).
REFERENCE_ADDRESS = ("city", "okrug", "district", "street", "house", "building", "apartment")


@dataclass(frozen=True)
class Delivery:
    """Что получила служба: сценарий ДДС (`delivered`), ничего — оператор её не выбрал
    (`not_delivered`) — или пока ничего: у сюжета нет докладов этой службы (`no_plot`)."""

    service_id: str
    status: DeliveryStatus
    scenario: dict[str, Any] | None = None
    stages: tuple[Stage, ...] = ()

    def as_json(self) -> dict[str, str]:
        result = {"service_id": self.service_id, "status": self.status}
        if self.scenario is not None:
            result["scenario_id"] = self.scenario["id"]
            result["plan"] = "wrong_address" if self.scenario["complications"] else "truth"
        return result


@dataclass(frozen=True)
class Handoff:
    """Передача карточки 112 службам; форма — contracts/examples/link-112-dds-handoff.json."""

    id: UUID
    record_id: str
    operator_scenario_id: str
    card: dict[str, Any]
    faults: tuple[Fault, ...]
    deliveries: tuple[Delivery, ...]

    def as_json(self) -> dict[str, Any]:
        return {
            "id": str(self.id),
            "source": {"kind": "record", "id": self.record_id},
            "operator_scenario_id": self.operator_scenario_id,
            "card": self.card,
            "faults": [fault.as_json() for fault in self.faults],
            "deliveries": [delivery.as_json() for delivery in self.deliveries],
        }


def handoff_id(record_id: str) -> UUID:
    return uuid5(NAMESPACE_URL, f"arm112:link112:{record_id}")


def scenario_id(record_id: str, service_id: str) -> UUID:
    return uuid5(NAMESPACE_URL, f"arm112:link112:{record_id}:{service_id}")


def load_records(directory: Path = LINK_DIR) -> list[dict[str, Any]]:
    return [
        json.loads(path.read_text(encoding="utf-8"))
        for path in sorted((directory / "records").glob("*.json"))
    ]


def load_plot(operator_scenario_id: str, directory: Path = LINK_DIR) -> dict[str, Any]:
    path = directory / "plots" / f"{operator_scenario_id}.json"
    plot: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return plot


def operator_scenario(operator_scenario_id: str) -> dict[str, Any]:
    for item in load_scenarios():
        if item["id"] == operator_scenario_id:
            return item
    raise ValueError(f"Сценарий оператора {operator_scenario_id} не найден.")


@lru_cache
def link_scenario_ids(directory: Path = LINK_DIR) -> frozenset[UUID]:
    """Все возможные сценарии ДДС связки: (запись, служба карточки). С запасом — по всем
    службам карточки, а не только с докладами: для исключения из тренировки этого хватает."""
    return frozenset(
        scenario_id(record["id"], service_id)
        for record in load_records(directory)
        for service_id in record["card"]["services"]
    )


def is_link_scenario(scenario: Scenario) -> bool:
    return scenario.id in link_scenario_ids()


def _plan_stages(
    variant: dict[str, Any], level: int, card: dict[str, Any], wrong_place: bool
) -> list[Stage]:
    plan = stages(variant, level)
    if not wrong_place:
        return plan
    if "wrong_address" not in variant:
        raise ValueError("Адрес в карточке уводит бригаду, а доклада для этого в сюжете нет.")
    # Бригада приезжает по адресу карточки, не находит происшествия и докладывает
    # уточнённый адрес; статус «Прибытие» — когда она на месте по правде сюжета.
    arrival = variant["wrong_address"]["arrival"].format(**card["address"])
    return [replace(stage, text=arrival) if stage.name == "arrival" else stage for stage in plan]


def _scenario_payload(
    record: dict[str, Any],
    truth: dict[str, Any],
    card: dict[str, Any],
    service_id: str,
    plan_stages: list[Stage],
    variant: dict[str, Any],
    wrong_place: bool,
    phone_ext: str,
) -> dict[str, Any]:
    """Сценарий ДДС по scenario.schema.json: карточка — как у оператора, эталон — что
    диспетчер мог знать."""
    level = record["level"]
    known = truth["address"] if wrong_place else card["address"]
    return {
        "id": str(scenario_id(record["id"], service_id)),
        "version": 1,
        "level": level,
        "weight": 1,
        "incident_type_code": card["incident_type_code"],
        "target_service_id": service_id,
        "card": card,
        "reference": {
            "expected_flow": expected_flow(variant, level),
            "required_fields": ["service_number", "comment"],
            "expected_service_ids": [service_id],
            # Уточнённый адрес бригада назвала в докладе — диспетчер его знает и пишет в
            # комментарий; иначе он знает только адрес карточки. Эталон — поля адреса из
            # scenario.schema.json: подъезд, этаж и ориентир карточки (OP-12) диспетчер не пишет.
            "expected_address": {field: known.get(field, "") for field in REFERENCE_ADDRESS},
            # Звонок своей службе не нужен: обязательные звонки задают события (GP-04).
            "expected_call": {
                "required": False,
                "service_id": service_id,
                "phone_ext": phone_ext,
                "before_s": 180,
            },
            "expected_comment": f"{card['description']} {plan_stages[-1].text}",
        },
        "complications": ["wrong_address"] if wrong_place else [],
        "origin": "template",
        "status": "approved",
        # Источник карточки видит преподаватель; в АРМ диспетчер его не видит (решение 08.10).
        "teacher_comment": (
            f"Связка 112 → ДДС, карточка от оператора-бота: {record['title']}. "
            f"{record['teacher_note']}"
        ),
    }


def build_handoff(
    record: dict[str, Any],
    truth: dict[str, Any],
    plot: dict[str, Any],
    phone_exts: Mapping[str, str],
) -> Handoff:
    """Передача по записи: карточка 112, ошибки оператора, сценарии ДДС по службам.

    `truth` — сценарий оператора, `plot` — доклады бригад сюжета, `phone_exts` — номера
    служб из справочника. Из записи берётся только карточка и уровень — так же построится
    передача по попытке живого оператора (шаг 2).
    """
    if plot["operator_scenario_id"] != truth["id"] or record["operator_scenario_id"] != truth["id"]:
        raise ValueError(f"Запись {record['id']}: сюжет и сценарий оператора не совпадают.")
    entered = CardInput.model_validate(record["card"])
    identifier = handoff_id(record["id"])
    card = card_for_dispatch(truth, entered, str(identifier))
    if card is None:
        raise ValueError(f"Запись {record['id']}: без типа происшествия карточки 112 нет.")
    faults = operator_faults(
        truth,
        incident_type_code=entered.incident_type_code,
        services=entered.services,
        address=entered.address.model_dump(),
    )
    wrong_place = sends_to_wrong_place(faults)
    deliveries: list[Delivery] = []
    for service_id in card["service_ids"]:
        variant = plot["services"].get(service_id)
        if variant is None:
            deliveries.append(Delivery(service_id, "no_plot"))
            continue
        if service_id not in phone_exts:
            raise ValueError(f"Служба {service_id} из карточки не найдена в справочнике служб.")
        plan_stages = _plan_stages(variant, record["level"], card, wrong_place)
        payload = _scenario_payload(
            record,
            truth,
            card,
            service_id,
            plan_stages,
            variant,
            wrong_place,
            phone_exts[service_id],
        )
        deliveries.append(Delivery(service_id, "delivered", payload, tuple(plan_stages)))
    deliveries += [
        Delivery(fault.service_id, "not_delivered")
        for fault in faults
        if fault.effect == "not_delivered" and fault.service_id is not None
    ]
    return Handoff(
        identifier,
        record["id"],
        truth["id"],
        card,
        tuple(faults),
        tuple(deliveries),
    )


def load_handoffs(phone_exts: Mapping[str, str], directory: Path = LINK_DIR) -> list[Handoff]:
    return [
        build_handoff(
            record,
            operator_scenario(record["operator_scenario_id"]),
            load_plot(record["operator_scenario_id"], directory),
            phone_exts,
        )
        for record in load_records(directory)
    ]


def _bank_version(folder: Path) -> int:
    found = re.fullmatch(r"bank-v(\d+)", folder.name)
    return int(found.group(1)) if found else 0


def bank_records(audio_dir: Path) -> dict[tuple[str, str], dict[str, Any]]:
    """(служба, текст) → запись банка озвучки; у одного текста — из самого нового набора."""
    found: dict[tuple[str, str], dict[str, Any]] = {}
    folders = sorted(
        (path.parent for path in audio_dir.glob("bank-v*/manifest.json")), key=_bank_version
    )
    for folder in folders:
        for item in json.loads((folder / "manifest.json").read_text(encoding="utf-8"))["messages"]:
            found[(item["service_id"], item["text"])] = item
    return found


async def bank_audio(
    db: AsyncSession,
    audio_dir: Path,
    bank: Mapping[tuple[str, str], dict[str, Any]],
    service_id: str,
    text: str,
) -> dict[str, Any] | None:
    """Запись банка реплики (служба, текст) или None — реплика уходит текстом."""
    item = bank.get((service_id, text))
    if item is None:
        return None
    return await audio_ref(db, audio_dir, {item["path"]: item}, item["path"], text)


def delivery_events(
    handoff: Handoff, delivery: Delivery, directory: Path = LINK_DIR
) -> tuple[list[dict[str, Any]], list[Line], dict[str, int] | None]:
    """«Живая бригада» (DT-10) сценария связки — блок `live` сюжета, как в тренировке:
    события плана, их реплики с путями озвучки и свои паузы этапов (`after_s`)."""
    if delivery.scenario is None:
        return [], [], None
    variant = load_plot(handoff.operator_scenario_id, directory)["services"][delivery.service_id]
    block = live(variant, delivery.scenario["level"])
    if block is None:
        return [], [], None
    events, lines = live_events(
        UUID(delivery.scenario["id"]),
        handoff.operator_scenario_id,
        delivery.service_id,
        block,
        AUDIO_ROOT,
    )
    return events, lines, block.get("after_s")


async def seed_link112(
    db: AsyncSession, audio_dir: Path, directory: Path = LINK_DIR
) -> list[Scenario]:
    """Сценарии ДДС связки; нужны seed_catalog (бригады) и преподаватель teacher."""
    teacher = await db.scalar(select(User).where(User.login == "teacher"))
    if teacher is None:
        raise RuntimeError("Сначала выполните основной seed: нужен преподаватель teacher.")
    services = {item.id: item for item in await db.scalars(select(Service))}
    phone_exts = {service_id: item.phone_ext for service_id, item in services.items()}
    bank = bank_records(audio_dir)
    created: list[Scenario] = []
    silent = 0
    for handoff in load_handoffs(phone_exts, directory):
        for delivery in handoff.deliveries:
            if delivery.scenario is None:
                continue
            scenario_uuid = UUID(delivery.scenario["id"])
            existing = await db.get(Scenario, scenario_uuid)
            if existing is not None:
                created.append(existing)
                continue
            scenario = Scenario(**{**delivery.scenario, "id": scenario_uuid}, author_id=teacher.id)
            db.add(scenario)
            await db.flush()
            events, lines, after_s = delivery_events(handoff, delivery, directory)
            for item in lines:
                audio = await bank_audio(
                    db, audio_dir, bank, delivery.service_id, item.message["text"]
                )
                silent += audio is None
                item.message["audio"] = audio
            audios = []
            for stage in delivery.stages:
                audio = await bank_audio(db, audio_dir, bank, delivery.service_id, stage.text)
                silent += audio is None
                audios.append(audio)
            plan = training_plan(
                scenario_uuid, delivery.service_id, list(delivery.stages), audios, events, after_s
            )
            await store_plan(db, scenario.id, scenario.version, teacher.id, plan)
            created.append(scenario)
    if silent:
        logger.warning(
            "Сценарии связки 112 → ДДС: %s докладов и реплик без озвучки — уйдут текстом "
            "(нет записи банка: scripts/voices/bank/link112, наборы data/voices/bank-v*).",
            silent,
        )
    await db.flush()
    return created
