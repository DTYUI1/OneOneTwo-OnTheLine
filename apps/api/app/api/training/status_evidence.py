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
# Этапы хода работ между выездом и итогом: каждый подтверждает свой доклад бригады.
_STAGES = frozenset({"responding", "arrived", "working"})
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
    message = (
        f"Статус «{_STATE_LABELS[target]}» пока недоступен: "
        "сначала получите и прослушайте доклад бригады."
    )
    if target in await never_reported_states(db, card):
        # Раздел 7 эталона: статус без доклада сервер не принимает — и тот, о котором
        # бригада в этом сценарии не докладывает вовсе.
        message = (
            f"Статус «{_STATE_LABELS[target]}» недоступен: бригада о таком этапе не докладывала."
        )
    if target == "responding":
        from app.api.training.briefing import dispatched

        if not await dispatched(db, card.id):
            # GP-05: бригада выезжает только после вводной в разговоре с ней.
            message = (
                "Статус «Начало реагирования» пока недоступен: бригада не выехала. "
                "Позвоните бригаде и дайте вводную: адрес и что случилось."
            )
    raise HTTPException(
        409,
        {"code": "report_required", "message": message, "details": {"state": target}},
    )


async def _card_plan(db: AsyncSession, card: Card) -> tuple[Scenario, list[dict[str, Any]]] | None:
    assignment = await db.get(Assignment, card.assignment_id)
    if assignment is None:
        return None
    scenario = await db.get(Scenario, assignment.scenario_id)
    if scenario is None:
        return None
    plan = await plan_for_assignment(db, assignment, scenario)
    if plan is None:
        return None
    return scenario, list(plan.plan["messages"])


def unreported_stages(scenario: Scenario, messages: list[dict[str, Any]]) -> set[str]:
    """Этапы, о которых бригада плана не докладывает и которых нет в эталоне хода статусов.

    Пустой план (сценарий без бригады) ничего не запрещает. Этап из эталона без доклада
    (старые планы) тоже остаётся доступным: иначе карточку нельзя провести по эталону.
    """
    justified = {justified_state(item, scenario.id) for item in messages}
    if not justified - {None}:
        return set()
    expected = set((scenario.reference or {}).get("expected_flow") or [])
    return set(_STAGES) - justified - expected


async def never_reported_states(db: AsyncSession, card: Card) -> set[str]:
    found = await _card_plan(db, card)
    return unreported_stages(*found) if found else set()


async def heard_reports(db: AsyncSession, card: Card) -> list[tuple[str, UUID]]:
    """Услышанные доклады карточки об этапах: (этап, бригада) в порядке выдачи.

    Доклад услышан — предъявлен (`message_presented`). Этап — по связи плана
    (`justified_state`); реплики без этапа (вопросы, ответы) не входят. Проверка памяти
    финальной смены (HQ-033) судит по ним, какие бригады на месте и какой доклад
    обучаемый ещё не отметил статусом.
    """
    found = await _card_plan(db, card)
    if found is None:
        return []
    scenario, messages = found
    stages = {
        (UUID(item["message"]["id"]), item["message"]["version"]): state
        for item in messages
        if (state := justified_state(item, scenario.id)) is not None
    }
    if not stages:
        return []
    rows = (
        await db.execute(
            select(
                MessageDelivery.message_id,
                MessageDelivery.message_version,
                MessageDelivery.brigade_id,
            )
            .select_from(MessagePresentation)
            .join(MessageDelivery, MessageDelivery.id == MessagePresentation.delivery_id)
            .where(
                MessageDelivery.card_id == card.id,
                MessagePresentation.kind == "message_presented",
                tuple_(MessageDelivery.message_id, MessageDelivery.message_version).in_(stages),
            )
            .order_by(MessageDelivery.delivered_at, MessageDelivery.id)
        )
    ).tuples()
    heard: list[tuple[str, UUID]] = []
    for message_id, version, brigade_id in rows:
        item = (stages[(message_id, version)], brigade_id)
        if item not in heard:
            heard.append(item)
    return heard


async def missing_report_states(db: AsyncSession, card: Card, candidates: list[str]) -> set[str]:
    """Какие из доступных переходов ждут подтверждённого доклада этого плана.

    Этап, о котором бригада плана не докладывает вовсе (`unreported_stages`), ждёт доклада
    всегда: статус без доклада сервер не принимает (эталон, раздел 7)."""
    candidates = [target for target in candidates if target in _STATE_LABELS]
    if not candidates:
        return set()
    found = await _card_plan(db, card)
    if found is None:
        return set()
    scenario, messages = found
    never = unreported_stages(scenario, messages) & set(candidates)
    evidence = {
        (UUID(item["message"]["id"]), item["message"]["version"]): state
        for item in messages
        if (state := justified_state(item, scenario.id)) in candidates
    }
    if not evidence:
        return never
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
    return never | (set(evidence.values()) - {evidence[pair] for pair in presented})
