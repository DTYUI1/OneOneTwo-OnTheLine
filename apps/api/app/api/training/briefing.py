"""Вводная бригаде (GP-05): бригада выезжает только после разговора с диспетчером.

Эталон — `docs/dds_gameplay.md`, разделы 3 (шаги 3–6), 4 и 7. Диспетчер звонит свободной
бригаде и говорит адрес и что случилось — голосом или по частям. Бригада повторяет адрес
(или ловушка сценария `readback_error` повторяет его с ошибкой) и после отбоя едет; что
выезжает, говорит доклад о выезде в том же разговоре — повтор адреса «Выезжаем» не дублирует
(проверка 17.10: «две фразы, что они выезжают»). Галочка на табло сил бригаду не отправляет.

- **Что поняла бригада** — `evalcore.briefing.briefing_check`, один раз при приёме события
  `brigade_briefing`; запись `BrigadeBriefing` читают и мир, и разбор.
- **Выезд** — первая полная вводная бригаде на карточке (`dispatched`): с неё идёт отсчёт
  докладов плана (`gating.schedule_reports`), бригада становится направленной сюда
  (`CardBrigade`). Доклад о выезде готов сразу — бригада говорит его в том же разговоре.
- **Неверный адрес** — бригада едет туда, что услышала: доклад о прибытии подменяется
  («прибыли, а здесь никто не вызывал») и приходит на `WRONG_ADDRESS_DELAY` позже (не дальше
  40 с от начала ожидания, `gating.MAX_REPORT_WAIT`), в разборе —
  критическая ошибка адреса (`evalcore.criteria.wrong_briefings`).
"""

import json
import logging
from dataclasses import replace
from datetime import datetime, timedelta
from functools import lru_cache
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from evalcore.briefing import ADDRESS_OK, Briefing, briefing_check
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.training.brigades import DECIDED_STATES as DECIDED
from app.api.training.gating import ScheduledReport, delayed, report_stage
from app.core.config import settings
from app.core.models import (
    Assignment,
    BrigadeBriefing,
    Call,
    Card,
    CardBrigade,
    LegacyBrigadeDispatch,
    MessageDelivery,
    MessagePresentation,
    Scenario,
    Street,
)
from app.core.read_cache import remembered
from app.core.spelling import for_scenario

# Бригада, уехавшая не туда, теряет время: доклад о прибытии приходит позже [ДОПУЩЕНИЕ],
# как у неисправленного повтора адреса (`readback_error`, ветка wrong — 45 с), но не дальше
# 40 с от начала ожидания доклада (`gating.MAX_REPORT_WAIT`, эталон, раздел 1, п. 5).
WRONG_ADDRESS_DELAY = timedelta(seconds=45)


def scenario_input(scenario: Scenario) -> dict[str, Any]:
    return {
        "incident_type_code": scenario.incident_type_code,
        "card": scenario.card,
        "reference": scenario.reference,
    }


async def card_scenario(db: AsyncSession, card: Card) -> Scenario | None:
    return await db.scalar(
        select(Scenario)
        .join(Assignment, Assignment.scenario_id == Scenario.id)
        .where(Assignment.id == card.assignment_id)
    )


async def check(db: AsyncSession, scenario: Scenario, text: str) -> Briefing:
    """Что бригада поймёт из фразы: справочник улиц стенда и улицы самого сценария."""
    streets = tuple((await db.scalars(select(Street.name))).all())
    return briefing_check(
        scenario_input(scenario),
        text,
        for_scenario(streets, scenario.card, scenario.reference),
    )


# Бригада службы с женским голосом банка (scripts/voices/casting/voices.json): «Приняла».
FEMALE_SERVICES = frozenset({"103"})


def readback_text(result: Briefing, service_id: str) -> str | None:
    """Повтор адреса полной вводной: «Повторяю: …». «Выезжаем» — в докладе о выезде."""
    if not result.complete:
        return None
    return f"Повторяю: {result.heard_address}."


@lru_cache(maxsize=1)
def recorded_readbacks() -> frozenset[tuple[str, str]]:
    """Записанные повторы адреса (служба, текст): наборы bank-v*, см. bank/addresses.py."""
    found: set[tuple[str, str]] = set()
    for manifest in sorted(settings.information_audio_dir.glob("bank-v*/manifest.json")):
        for item in json.loads(manifest.read_text(encoding="utf-8"))["messages"]:
            if item.get("slot") == "readback":
                found.add((item["service_id"], item["text"]))
    return frozenset(found)


def readback(result: Briefing, trap: bool, service_id: str) -> str | None:
    """Ответ бригады на полную вводную: повтор адреса.

    Ловушка сценария (`readback_error`) сама повторяет верный адрес с ошибкой — тогда
    бригада молчит до доклада о выезде. Неверный адрес бригада повторяет как услышала, если
    такой повтор записан (верный адрес и похожие ошибки вариантов по частям). Адрес не из
    записей бригада не повторяет — сразу доклад о выезде: текстом без голоса она не говорит
    (проверка 17.10), а ошибка адреса видна на прибытии.
    """
    if trap and result.address == ADDRESS_OK:
        return None
    text = readback_text(result, service_id)
    return text if text and (service_id, text) in recorded_readbacks() else None


# Переспрос вводной — фразы банка своей службы (GP-28, место briefing_ask, asks: both,
# address, what); у службы без книги — пожарный расчёт. Совпадение с банком — test_brigade_briefing.
ASK_AGAIN: dict[str, dict[str, str]] = {
    "101": {
        "both": "Не понял. Назовите адрес и что случилось.",
        "address": "Адрес не разобрал. Улицу и номер дома повторите.",
        "what": "Адрес принял. Что горит, что случилось?",
    },
    "102": {
        "both": "Не понял вас. Адрес и что произошло, коротко.",
        "address": "Адрес повторите: улица, номер дома.",
        "what": "Адрес записал. Что там произошло?",
    },
    "103": {
        "both": "Не поняла. Назовите адрес и что с больным.",
        "address": "Адрес не расслышала. Улицу и дом повторите.",
        "what": "Адрес приняла. Что случилось, кому плохо?",
    },
    "104": {
        "both": "Не понял. Адрес и что там с газом?",
        "address": "Не разобрал адрес. Назовите улицу и номер дома.",
        "what": "Адрес принял. Что случилось, где пахнет?",
    },
    "GKH": {
        "both": "Не понял. Куда ехать и что там случилось?",
        "address": "Адрес не расслышал. Улица, дом какой?",
        "what": "Адрес записал. А что случилось-то?",
    },
    "MOSLIFT": {
        "both": "Не понял. Адрес и что с лифтом?",
        "address": "Адрес повторите, пожалуйста: улица и дом.",
        "what": "Адрес принял. Что с лифтом: застряли или не работает?",
    },
}


def ask_again(result: Briefing, service_id: str) -> str | None:
    """Чего бригаде не хватило — фразой банка её службы; None — вводная полная."""
    if result.complete:
        return None
    phrases = ASK_AGAIN.get(service_id, ASK_AGAIN["101"])
    if result.address == "missing" and not (result.incident or result.incident_said):
        return phrases["both"]
    if result.address == "missing":
        return phrases["address"]
    return phrases["what"]


def has_readback_trap(events: list[dict[str, Any]]) -> bool:
    return any(event.get("kind") == "readback_error" for event in events)


async def briefing_call(db: AsyncSession, card: Card, call_id: UUID) -> Call:
    """Идущий разговор с бригадой, которой можно дать вводную; иначе 409 с причиной."""
    if card.state not in DECIDED:
        raise HTTPException(
            409,
            "Вводную бригаде дают после решения по карточке: сначала статус «Принята».",
        )
    call = await db.get(Call, call_id, with_for_update=True)
    if call is None or call.card_id != card.id:
        raise HTTPException(404, "Звонок не найден.")
    if call.brigade_id is None or call.refusal is not None:
        raise HTTPException(409, "Вводную дают в разговоре со свободной бригадой своей службы.")
    if call.answered_at is None or call.ended_at is not None:
        raise HTTPException(409, "Вводную дают, пока идёт разговор с бригадой.")
    return call


async def said_call(db: AsyncSession, card: Card, call_id: UUID) -> Call:
    """Идущий разговор с бригадой своей карточки (GP-11, `brigade_said`); иначе 404 или 409.

    Сказать можно любое: решения по карточке и вводной не требуется — «доложите обстановку»
    уместно в любой момент разговора. Входящий вызов бригады тоже годится, пока он идёт.
    """
    call = await db.get(Call, call_id)
    if call is None or call.card_id != card.id:
        raise HTTPException(404, "Звонок не найден.")
    if call.brigade_id is None:
        raise HTTPException(409, "Это не разговор с бригадой.")
    if call.answered_at is None or call.ended_at is not None:
        raise HTTPException(409, "Бригаде говорят, пока идёт разговор с ней.")
    return call


async def confirm_report(db: AsyncSession, card: Card, payload: dict[str, Any]) -> None:
    """«Принял» на «Как приняли?» (TC-01, `report_confirmed`); иначе 404 или 409.

    Подтверждают доклад бригады, с которой идёт разговор, и только прозвучавший: до конца
    доклада подтверждать нечего. Выдача может быть из прежнего звонка этой бригады —
    перезвон с непрослушанным докладом.
    """
    call = await said_call(db, card, UUID(payload["call_id"]))
    delivery = await db.get(MessageDelivery, UUID(payload["delivery_id"]))
    if delivery is None or delivery.card_id != card.id:
        raise HTTPException(404, "Доклад не найден.")
    if delivery.brigade_id != call.brigade_id:
        raise HTTPException(409, "Это доклад другой бригады.")
    presented = await db.scalar(
        select(MessagePresentation.id).where(
            MessagePresentation.delivery_id == delivery.id,
            MessagePresentation.kind == "message_presented",
        )
    )
    if presented is None:
        raise HTTPException(409, "Доклад ещё не прозвучал — подтверждать нечего.")


async def record_briefing(
    db: AsyncSession, card: Card, payload: dict[str, Any], now: datetime
) -> BrigadeBriefing:
    """Событие `brigade_briefing`: что поняла бригада; полная вводная её отправляет."""
    call = await briefing_call(db, card, UUID(payload["call_id"]))
    scenario = await card_scenario(db, card)
    if scenario is None:
        raise HTTPException(404, "Звонок не найден.")
    result = await check(db, scenario, payload["text"])
    assert call.brigade_id is not None
    row = BrigadeBriefing(
        id=uuid4(),
        card_id=card.id,
        call_id=call.id,
        brigade_id=call.brigade_id,
        briefed_at=now,
        mode=payload["mode"],
        text=payload["text"],
        address=result.address,
        heard_address=result.heard_address,
        incident=result.incident,
        complete=result.complete,
    )
    db.add(row)
    if result.complete and await db.get(CardBrigade, (card.id, call.brigade_id)) is None:
        db.add(CardBrigade(card_id=card.id, brigade_id=call.brigade_id))
    await db.flush()
    return row


async def card_briefings(db: AsyncSession, card_id: UUID) -> list[BrigadeBriefing]:
    async def load() -> list[BrigadeBriefing]:
        return list(
            await db.scalars(
                select(BrigadeBriefing)
                .where(BrigadeBriefing.card_id == card_id)
                .order_by(BrigadeBriefing.briefed_at, BrigadeBriefing.id)
            )
        )

    return list(await remembered(db, ("card_briefings", card_id), load))


def dispatching(briefings: list[BrigadeBriefing]) -> dict[UUID, BrigadeBriefing]:
    """Бригада → вводная, по которой она выехала (первая полная)."""
    sent: dict[UUID, BrigadeBriefing] = {}
    for row in briefings:
        if row.complete:
            sent.setdefault(row.brigade_id, row)
    return sent


async def dispatched(db: AsyncSession, card_id: UUID) -> dict[UUID, datetime]:
    """Бригада → первая отправка: вводная или точный снимок старого правила из миграции."""
    result = {
        brigade: row.briefed_at
        for brigade, row in dispatching(await card_briefings(db, card_id)).items()
    }
    for legacy in await db.scalars(
        select(LegacyBrigadeDispatch).where(LegacyBrigadeDispatch.card_id == card_id)
    ):
        result[legacy.brigade_id] = min(
            result.get(legacy.brigade_id, legacy.dispatched_at), legacy.dispatched_at
        )
    return result


def briefing_record(row: BrigadeBriefing) -> dict[str, Any]:
    """Вводная для разбора (`EvalContext.briefings`)."""
    return {
        "brigade_id": str(row.brigade_id),
        "at": row.briefed_at.isoformat(),
        "mode": row.mode,
        "text": row.text,
        "address": row.address,
        "heard_address": row.heard_address,
        "incident": row.incident,
        "complete": row.complete,
    }


async def evaluation_briefings(db: AsyncSession, card_id: UUID) -> tuple[dict[str, Any], ...]:
    """Вводные карточки для разбора (`EvalContext.briefings`)."""
    return tuple(briefing_record(row) for row in await card_briefings(db, card_id))


MOVED_ID = "{service}.wrong_place.moved"
# Текст той же фразы банка (scripts/voices/bank/addresses.py берёт его отсюда).
MOVED_TEXT = (
    "Диспетчер, по тому адресу никто не вызывал. Сверились с карточкой, переехали, "
    "теперь на месте. Потеряли время."
)


def asset_ref(item: dict[str, Any]) -> dict[str, Any]:
    """Ссылка на запись набора bank-v*, как у реплик сценария (`app.seed.practice.audio_ref`).

    Запись регистрирует seed (`app.seed.scenarios.seed_moved_audio`); id — от пути файла.
    """
    asset_id = uuid5(NAMESPACE_URL, f"arm112:practice:audio:{item['path']}")
    return {
        "asset_id": str(asset_id),
        "version": 1,
        "sha256": item["sha256"],
        "url": f"/api/materials/{asset_id}/content?version=1",
        "duration_ms": item["duration_ms"],
    }


@lru_cache(maxsize=1)
def moved_items() -> dict[str, dict[str, Any]]:
    """Записи «переехали по карточке» по службам (scripts/voices/bank/addresses.py)."""
    found: dict[str, dict[str, Any]] = {}
    for manifest in sorted(settings.information_audio_dir.glob("bank-v*/manifest.json")):
        for item in json.loads(manifest.read_text(encoding="utf-8"))["messages"]:
            if item["id"] == MOVED_ID.format(service=item["service_id"]):
                found[item["service_id"]] = item
    return found


def wrong_arrival(service_id: str) -> dict[str, Any]:
    """Доклад о прибытии бригады, которая уехала по неверному адресу вводной: текст и запись.

    Адреса в докладе нет: голосом мог прозвучать любой, а бригада говорит только записями
    (проверка 17.10). Записи у службы нет — тот же текст без звука.
    """
    item = moved_items().get(service_id)
    if item is None:
        return {"text": MOVED_TEXT, "audio": None}
    return {"text": item["text"], "audio": asset_ref(item)}


WRONG_INCIDENT_ID = "{service}.update.wrong_briefing.1"
WRONG_INCIDENT_TEXT = (
    "Диспетчер, вводная не совпала с обстановкой на месте. Уточнили, работаем по факту."
)


@lru_cache(maxsize=1)
def wrong_incident_prefix_items() -> dict[str, dict[str, Any]]:
    """Шесть разрешённых записей служб; не случайные варианты обычного хода работ."""
    found: dict[str, dict[str, Any]] = {}
    for manifest in sorted(settings.information_audio_dir.glob("bank-v*/manifest.json")):
        for item in json.loads(manifest.read_text(encoding="utf-8"))["messages"]:
            if (
                item["id"] == WRONG_INCIDENT_ID.format(service=item["service_id"])
                and item.get("text") == WRONG_INCIDENT_TEXT
            ):
                found[item["service_id"]] = item
    return found


@lru_cache(maxsize=1)
def wrong_incident_items() -> dict[tuple[str, str], dict[str, Any]]:
    """Составные записи: приставка своей службы и исходный доклад о прибытии.

    source_text манифеста задаёт неизменённый доклад, включая подмены событий мира и
    неверного адреса. Исходную запись нельзя прикрепить к тексту с приставкой:
    стандартные поля озвучки должны ссылаться на фактический составной файл.
    """
    found: dict[tuple[str, str], dict[str, Any]] = {}
    for manifest in sorted(settings.information_audio_dir.glob("bank-v*/manifest.json")):
        for item in json.loads(manifest.read_text(encoding="utf-8"))["messages"]:
            source = item.get("source_text")
            if (
                isinstance(source, str)
                and item.get("slot") == "update"
                and item.get("text") == f"{WRONG_INCIDENT_TEXT} {source}"
            ):
                found[(item["service_id"], source)] = item
    return found


def apply_wrong_incident(
    reports: list[ScheduledReport],
    sent: dict[UUID, BrigadeBriefing],
    scenario: Scenario | None,
    issued: set[tuple[UUID, int]] | None = None,
) -> list[ScheduledReport]:
    """Неверный повод первой отправки: замечание без потери фактов исходного доклада.

    Применяется после событий мира и неверного адреса. Запись каталога содержит приставку
    и исходный доклад; идентичность, срок, обоснование статуса и дальнейшие доклады прежние.
    Для старой/авторской реплики без составной записи выдаём записанную приставку отдельно,
    перед неизменным исходным докладом. Она сама не обосновывает статус прибытия.
    """
    wrong = {brigade for brigade, row in sent.items() if not row.incident}
    if not wrong or scenario is None:
        return reports
    adjusted = []
    for report in reports:
        if (
            report.brigade_id not in wrong
            or report.issued
            or report_stage(report.planned) != "arrived"
        ):
            adjusted.append(report)
            continue
        original = report.planned["message"]
        item = wrong_incident_items().get((scenario.target_service_id, original["text"]))
        if item is None:
            prefix = wrong_incident_prefix_items().get(scenario.target_service_id)
            if prefix is not None:
                identity = (uuid5(report.identity[0], f"wrong-incident:{report.brigade_id}"), 1)
                adjusted.append(
                    replace(
                        report,
                        identity=identity,
                        issued=identity in (issued or set()),
                        planned={
                            "message": {
                                "id": str(identity[0]),
                                "version": identity[1],
                                "text": prefix["text"],
                                "audio": asset_ref(prefix),
                            }
                        },
                    )
                )
            else:
                # Историческая служба без записи: не ломаем чтение и не выдумываем озвучку.
                logging.getLogger(__name__).warning(
                    "Нет записи замечания о неверной вводной для службы %s; "
                    "исходный доклад сохранён.",
                    scenario.target_service_id,
                )
            adjusted.append(report)
            continue
        message = {**original, "text": item["text"], "audio": asset_ref(item)}
        adjusted.append(replace(report, planned={**report.planned, "message": message}))
    return adjusted


def apply_wrong_address(
    reports: list[ScheduledReport],
    sent: dict[UUID, BrigadeBriefing],
    scenario: Scenario | None,
) -> list[ScheduledReport]:
    """Бригада, уехавшая по неверному адресу, докладывает о прибытии «не туда» и позже."""
    wrong = {
        brigade: row.heard_address or "" for brigade, row in sent.items() if row.address == "wrong"
    }
    if not wrong or scenario is None:
        return reports
    adjusted = []
    for report in reports:
        heard = wrong.get(report.brigade_id)
        if heard is None or report.issued or report_stage(report.planned) != "arrived":
            adjusted.append(report)
            continue
        message = {**report.planned["message"], **wrong_arrival(scenario.target_service_id)}
        adjusted.append(
            replace(
                report,
                planned={**report.planned, "message": message},
                ready_at=(
                    delayed(report, report.ready_at, WRONG_ADDRESS_DELAY)
                    if report.ready_at
                    else None
                ),
            )
        )
    return adjusted
