"""Связь этапа карточки с подтверждённым докладом выданного учебного плана."""

from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5

from fastapi import HTTPException
from sqlalchemy import select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.training.content import plan_for_assignment
from app.core.models import (
    Assignment,
    Card,
    MessageDelivery,
    MessagePresentation,
    Scenario,
)

_SEED_STAGES = {
    "departure": "responding",
    "arrival": "arrived",
    "works": "working",
    "completion": "completed",
    "complication": "refused",
}
_TEXT_DEMO_ID = uuid5(NAMESPACE_URL, "arm112:c04:text-demo")
_TEXT_DEMO_STATES = {0: "arrived", 1: "completed"}
_STATE_LABELS = {
    "responding": "Начало реагирования",
    "arrived": "Прибытие",
    "working": "Проведение работ",
    "completed": "Работы завершены",
    "refused": "Отказ от выполнения работ",
}


def justified_state(planned: dict[str, Any], scenario_id: UUID) -> str | None:
    """Явная связь из плана; для выданных до неё сидов — стабильный UUID этапа.

    Старые планы неизменяемы. UUID5 был создан сидом от scenario_id и имени этапа;
    совпадение надёжнее догадки по тексту сообщения или позиции в списке.
    """
    explicit = planned.get("justifies_state")
    if isinstance(explicit, str):
        return explicit
    message_id = UUID(planned["message"]["id"])
    for stage, state in _SEED_STAGES.items():
        if message_id == uuid5(scenario_id, f"message:{stage}"):
            return state
    if scenario_id == _TEXT_DEMO_ID:
        for index, state in _TEXT_DEMO_STATES.items():
            if message_id == uuid5(scenario_id, f"message:{index}"):
                return state
    return None


async def require_report_before_status(db: AsyncSession, card: Card, target: str) -> None:
    """Этап хода работ нельзя утверждать раньше предъявленного доклада о нём."""
    if target not in await missing_report_states(db, card, [target]):
        return
    raise HTTPException(
        409,
        {
            "code": "report_required",
            "message": (
                f"Статус «{_STATE_LABELS[target]}» пока недоступен: "
                "сначала получите и прослушайте доклад бригады."
            ),
            "details": {"state": target},
        },
    )


async def missing_report_states(db: AsyncSession, card: Card, candidates: list[str]) -> set[str]:
    """Какие из доступных переходов ждут подтверждённого доклада этого плана."""
    candidates = [target for target in candidates if target in _STATE_LABELS]
    if not candidates:
        return set()
    assignment = await db.get(Assignment, card.assignment_id)
    if assignment is None:
        return set()
    scenario = await db.get(Scenario, assignment.scenario_id)
    if scenario is None:
        return set()
    plan = await plan_for_assignment(db, assignment, scenario)
    if plan is None:
        return set()
    evidence = {
        (UUID(item["message"]["id"]), item["message"]["version"]): state
        for item in plan.plan["messages"]
        if (state := justified_state(item, scenario.id)) in candidates
    }
    if not evidence:
        return set()
    presented = (
        (
            await db.execute(
                select(MessageDelivery.message_id, MessageDelivery.message_version)
                .select_from(MessagePresentation)
                .join(MessageDelivery, MessageDelivery.id == MessagePresentation.delivery_id)
                .where(
                    MessageDelivery.card_id == card.id,
                    MessagePresentation.kind == "message_presented",
                    tuple_(MessageDelivery.message_id, MessageDelivery.message_version).in_(
                        evidence
                    ),
                )
            )
        )
        .tuples()
        .all()
    )
    return set(evidence.values()) - {evidence[pair] for pair in presented}
