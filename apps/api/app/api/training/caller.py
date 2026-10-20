"""Живой заявитель (HQ-019, `docs/dds_caller.md`): реплики его книг банка на сервере.

Разговор с заявителем ведёт окно телефона (`apps/web/src/arm/softphone/caller/`): диспетчер
спрашивает, заявитель отвечает фразами книги своего характера. Сервер только записывает,
какая фраза прозвучала (`caller_said {call_id, phrase_id}`), и отдаёт оценке реплики со
сведением сюжета (`EvalContext.lines`, HQ-020): «будет через пять минут» в комментарии
засчитано, только если записано после ответа заявителя.

Книги — `scripts/voices/bank/callers/CALLER_<характер>.json` (формат банка,
`scripts/voices/bank/README.md`); образ API их содержит (`COPY scripts`).
"""

import json
from collections.abc import Sequence
from functools import lru_cache
from typing import Any
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.training.contacts import card_phone
from app.core.config import ROOT
from app.core.models import Assignment, Call, Card, CardEvent, Scenario

CALLERS_DIR = ROOT / "scripts" / "voices" / "bank" / "callers"
CHARACTERS = {"calm": "CALLER_CALM", "confused": "CALLER_CONFUSED"}


@lru_cache(maxsize=1)
def caller_phrases() -> dict[str, dict[str, Any]]:
    """Id фразы заявителя → фраза книги (`slot`, `text`, `tells`, `on`, `incidents`)."""
    found: dict[str, dict[str, Any]] = {}
    for path in sorted(CALLERS_DIR.glob("*.json")):
        book = json.loads(path.read_text(encoding="utf-8"))
        for phrase in book["phrases"]:
            found[phrase["id"]] = phrase
    return found


def caller_plots() -> set[str]:
    """Сюжеты, с которыми окно телефона ведёт разговор: есть таблица сюжета (`callers/plots/`)
    и реплики в книге каждого характера. Сюжет без книги характера окно не нашло бы и
    отдало звонок дежурному службы — линтер сценариев такой сюжет не пропускает."""
    tables = {path.stem for path in (CALLERS_DIR / "plots").glob("*.json")}
    voiced = [
        {
            incident
            for phrase in caller_phrases().values()
            if phrase["id"].startswith(f"{book}.")
            for incident in phrase["incidents"]
        }
        for book in CHARACTERS.values()
    ]
    return tables.intersection(*voiced)


def tells_fact(phrase: dict[str, Any]) -> bool:
    """Реплика даёт сведение сюжета: есть `tells`, и это не неполный ответ (`on: first`)."""
    return bool(phrase.get("tells")) and phrase.get("on") != "first"


async def role_numbers(db: AsyncSession, card: Card, role: str) -> set[str]:
    """Номера роли телефона ДДС на занятии карточки (роли нет в списке — пусто)."""
    return (await card_phone(db, card)).numbers(role)


async def caller_numbers(db: AsyncSession, card: Card) -> set[str]:
    """Номера роли «Заявитель» в телефоне ДДС занятия карточки."""
    return await role_numbers(db, card, "caller")


async def caller_plan(db: AsyncSession, card: Card) -> dict[str, Any]:
    """План выдачи, а не изменяемый исходник каталога: старые выдачи сохраняют контракт."""
    from app.api.training.content import plan_for_assignment

    assignment = await db.get(Assignment, card.assignment_id)
    scenario = await db.get(Scenario, assignment.scenario_id) if assignment is not None else None
    if assignment is None or scenario is None:
        return {}
    plan = await plan_for_assignment(db, assignment, scenario)
    return plan.plan if plan is not None else {}


def requires_caller_facts(plan: dict[str, Any]) -> bool:
    """Строгий содержательный контракт включён только явно, не для исторических выдач."""
    return any(
        branch.get("awaits_call", {}).get("required_facts")
        for event in plan.get("events", [])
        for branch in event.get("branches", {}).values()
    )


def phrase_allowed(phrase: dict[str, Any], plan: dict[str, Any], character: str) -> bool:
    """Реплика разрешена сюжетом карточки и выбранным характером заявителя."""
    caller = plan.get("caller", {})
    return caller.get("plot") in phrase.get("incidents", []) and phrase["id"].startswith(
        CHARACTERS.get(character, "!") + "."
    )


async def caller_fact_records(
    db: AsyncSession, card: Card, calls: Sequence[Call]
) -> list[dict[str, Any]]:
    """Полные авторизованные факты; время ответа сохраняется для отсечения старого звонка."""
    plan = await caller_plan(db, card)
    if not requires_caller_facts(plan):
        return []
    phone = await card_phone(db, card)
    contacts = {item["number"]: item for item in phone.contacts if item["role"] == "caller"}
    valid = {
        str(call.id): call
        for call in calls
        if call.card_id == card.id
        and call.answered_at is not None
        and call.direction == "outbound"
        and call.refusal is None
        and call.dialed_ext in contacts
    }
    rows = await db.scalars(
        select(CardEvent).where(CardEvent.card_id == card.id, CardEvent.type == "caller_said")
    )
    facts: list[dict[str, Any]] = []
    for event in rows:
        call = valid.get(str(event.payload.get("call_id")))
        phrase = caller_phrases().get(str(event.payload.get("phrase_id")))
        if call is None or phrase is None or not tells_fact(phrase):
            continue
        character = contacts[call.dialed_ext].get("character") or plan["caller"].get(
            "character", "calm"
        )
        if not phrase_allowed(phrase, plan, character):
            continue
        facts.extend(
            {"key": key, "at": event.server_ts, "answered_at": call.answered_at}
            for key in (
                phrase["tells"]
                if isinstance(phrase["tells"], list)
                else str(phrase["tells"]).split(",")
            )
        )
    return facts


async def record_caller_line(db: AsyncSession, card: Card, payload: dict[str, Any]) -> None:
    """`caller_said`: реплика заявителя прозвучала в звонке карточки на номер заявителя.

    Запись — сама строка card_events. Звонок мог уже кончиться (событие идёт очередью следом
    за репликой, отбой — за ним), карточка — закрыться: разговор с заявителем статусу не
    подчинён. Не тот звонок — 409 `caller_line` (очередь карточки не останавливает),
    не фраза заявителя — 422.
    """
    if payload["phrase_id"] not in caller_phrases():
        raise HTTPException(422, "Нет такой фразы заявителя.")
    call = await db.get(Call, UUID(payload["call_id"]))
    if call is None or call.card_id != card.id:
        raise HTTPException(404, "Звонок не найден.")
    if call.answered_at is None or call.dialed_ext not in await caller_numbers(db, card):
        raise HTTPException(
            409,
            {
                "code": "caller_line",
                "message": "Реплика заявителя — только в отвеченном звонке заявителю.",
                "details": {},
            },
        )

    plan = await caller_plan(db, card)
    if requires_caller_facts(plan):
        phone = await card_phone(db, card)
        character = next(
            (
                item.get("character")
                for item in phone.contacts
                if item["role"] == "caller" and item["number"] == call.dialed_ext
            ),
            None,
        ) or plan.get("caller", {}).get("character", "calm")
        if not phrase_allowed(caller_phrases()[payload["phrase_id"]], plan, character):
            raise HTTPException(
                409,
                {
                    "code": "caller_line",
                    "message": "Реплика не принадлежит заявителю этой карточки.",
                    "details": {},
                },
            )
