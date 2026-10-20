"""Повтор незачтённого сценария (TC-11, docs/dds_touches.md): «было 45 → стало 82».

Сценарий, по которому у обучаемого есть незачтённая попытка, возвращается в «Мой путь»
повтором: его можно пройти ещё раз (`POST /practice?scenario_id=…`), а рядом видно, как
изменился балл. «Было» — балл первой незачтённой попытки, «стало» — последней попытки после
неё. Засчитываются карточки и занятий, и тренировок; в повтор идут только сценарии, которые
тренировка может выдать: не упражнение и не связка 112, ещё выдаётся (`autogen.issuable`),
бригада докладывает до конца (`plan_check`), ступень открыта.
"""

from collections import defaultdict
from typing import Any
from uuid import UUID

from evalcore.progress import STEPS, Step, StepProgress  # type: ignore[import-untyped]
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.progress.service import ScoredCard, scored_cards
from app.api.training.autogen import issuable
from app.api.training.plan_check import missing_reports, plan_messages
from app.core.models import Scenario

# Сколько повторов показывать: одно-два дела проще удержать, чем список.
REPEAT_LIMIT = 3


def repeat_step(scenario: Scenario) -> Step | None:
    """Ступень тренировки, которая выдаёт сценарий этого уровня; None — в тренировку не идёт."""
    from app.api.sessions.practice import practice_candidate

    if not practice_candidate(scenario):
        return None
    return next(
        (step for step in STEPS if not step.tutorial and scenario.level in step.levels), None
    )


async def repeatable(db: AsyncSession, scenario: Scenario) -> bool:
    """Тренировка может выдать сценарий: он ещё выдаётся и бригада докладывает до конца."""
    if await db.scalar(select(Scenario.id).where(Scenario.id == scenario.id, issuable())) is None:
        return False
    messages = await plan_messages(db, scenario)
    return bool(messages) and not missing_reports(scenario, messages)


def _entry(items: list[ScoredCard], step: Step) -> dict[str, Any] | None:
    failed = next((index for index, item in enumerate(items) if not item.passed), None)
    if failed is None:
        return None
    last = items[-1]
    repeated = len(items) > failed + 1
    return {
        "scenario_id": last.scenario.id,
        "number": last.card.number,
        "incident_class": str(last.scenario.card.get("incident_class", "")),
        "step": step.number,
        "was": items[failed].total,
        "now": last.total if repeated else None,
        "passed": repeated and last.passed,
        "last_card_id": last.card.id,
    }


async def repeats(
    db: AsyncSession, user_id: UUID, progress: list[StepProgress]
) -> list[dict[str, Any]]:
    """Повторы (ScenarioRepeat, openapi): сначала не исправленные, затем новые первыми."""
    unlocked = {item.number for item in progress if item.unlocked}
    by_scenario: dict[UUID, list[ScoredCard]] = defaultdict(list)
    for item in sorted(
        await scored_cards(db, user_id), key=lambda x: x.card.closed_at or x.card.appeared_at
    ):
        by_scenario[item.scenario.id].append(item)
    candidates: list[tuple[dict[str, Any], Scenario, float]] = []
    for items in by_scenario.values():
        scenario = items[-1].scenario
        step = repeat_step(scenario)
        if step is None or step.number not in unlocked:
            continue
        entry = _entry(items, step)
        if entry is not None:
            last = items[-1].card
            candidates.append((entry, scenario, (last.closed_at or last.appeared_at).timestamp()))
    candidates.sort(key=lambda item: (item[0]["passed"], -item[2]))
    result: list[dict[str, Any]] = []
    for entry, scenario, _ in candidates:
        if len(result) == REPEAT_LIMIT:
            break
        if await repeatable(db, scenario):
            result.append(entry)
    return result


async def repeat_scenario(
    db: AsyncSession, user_id: UUID, scenario_id: UUID, progress: list[StepProgress]
) -> tuple[Scenario, Step]:
    """Сценарий повтора и его ступень; не из списка повторов — 409 repeat_unavailable."""
    found = next(
        (
            item
            for item in await repeats(db, user_id, progress)
            if item["scenario_id"] == scenario_id
        ),
        None,
    )
    scenario = await db.get(Scenario, scenario_id) if found else None
    step = repeat_step(scenario) if scenario is not None else None
    if scenario is None or step is None:
        raise HTTPException(
            409,
            {
                "code": "repeat_unavailable",
                "message": "Повтор недоступен: этого сценария нет среди повторов в «Моём пути».",
                "details": {},
            },
        )
    return scenario, step
