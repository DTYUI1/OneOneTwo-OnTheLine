"""Публичная проекция выдач; ожидаемые действия остаются только в плане учителя."""

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from evalcore.defaults import CARD_TRANSITIONS  # type: ignore[import-untyped]
from fastapi import HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.c01 import C01Input
from app.api.cards import repo as card_repo
from app.api.notifications import notify
from app.api.training.brigades import brigade_roster
from app.api.training.content import plan_for_assignment
from app.api.training.gating import awaiting_state, status_history
from app.api.training.status_evidence import missing_report_states
from app.core.models import (
    Assignment,
    Brigade,
    Call,
    CallTarget,
    Card,
    CardBrigade,
    CardEvent,
    CardTrainingState,
    MessageDelivery,
    MessagePresentation,
    Participant,
    Scenario,
    Service,
    Session,
)


class BrigadeView(C01Input):
    contract_name = "Brigade"


class CallTargetView(C01Input):
    contract_name = "CallTarget"


class TrainingView(C01Input):
    contract_name = "CardTraining"


def timestamp(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


async def catalog(request: Request, service_id: str, *, targets: bool = False) -> list[Any]:
    db = request.state.db
    if await db.get(Service, service_id) is None:
        raise HTTPException(404, "Служба не найдена.")
    if targets:
        rows = await db.scalars(
            select(CallTarget)
            .where(CallTarget.service_id == service_id)
            .order_by(CallTarget.name, CallTarget.id)
        )
        return [
            CallTargetView(
                {
                    "id": str(r.id),
                    "service_id": r.service_id,
                    "name": r.name,
                    "brigade_id": str(r.brigade_id) if r.brigade_id else None,
                    "phone_ext": r.phone_ext,
                    "voice_profile": r.voice_profile,
                    "is_active": r.is_active,
                }
            )
            for r in rows
        ]
    brigades = await db.scalars(
        select(Brigade).where(Brigade.service_id == service_id).order_by(Brigade.name, Brigade.id)
    )
    return [
        BrigadeView(
            {"id": str(r.id), "service_id": r.service_id, "name": r.name, "is_active": r.is_active}
        )
        for r in brigades
    ]


async def bump_revision(db: AsyncSession, card_id: UUID) -> None:
    """Вызывается только после блокировки карточки; NOTIFY выходит после commit."""
    state = await db.get(CardTrainingState, card_id)
    if state is None:
        state = CardTrainingState(card_id=card_id, revision=2)
        db.add(state)
    else:
        state.revision += 1
    await db.flush()
    await notify(db, "training.updated", card_id)


async def training_projection(db: AsyncSession, card_id: UUID) -> TrainingView:
    """Проекция для V-02: только state=presented подтверждает предъявление."""
    card = await db.get(Card, card_id)
    roster = await brigade_roster(db, card) if card is not None else None
    selected = list(
        await db.scalars(
            select(CardBrigade.brigade_id)
            .where(CardBrigade.card_id == card_id)
            .order_by(CardBrigade.brigade_id)
        )
    )
    state = await db.get(CardTrainingState, card_id)
    deliveries = list(
        (
            await db.execute(
                select(MessageDelivery, Participant.user_id)
                .join(Participant, Participant.id == MessageDelivery.participant_id)
                .where(MessageDelivery.card_id == card_id)
                .order_by(MessageDelivery.delivered_at, MessageDelivery.id)
            )
        ).tuples()
    )
    presentations = list(
        (
            await db.execute(
                select(MessagePresentation, CardEvent.client_event_id)
                .join(CardEvent, CardEvent.id == MessagePresentation.event_id)
                .where(MessagePresentation.delivery_id.in_([d.id for d, _ in deliveries]))
                .order_by(MessagePresentation.recorded_at, MessagePresentation.id)
            )
        ).tuples()
    )
    messages = []
    for delivery, user_id in deliveries:
        attempts = [(p, event_id) for p, event_id in presentations if p.delivery_id == delivery.id]
        success = next(((p, eid) for p, eid in attempts if p.kind == "message_presented"), None)
        failed = attempts[-1][0] if attempts and success is None else None
        messages.append(
            {
                "delivery": {
                    "delivery_id": str(delivery.id),
                    "card_id": str(card_id),
                    "call_id": str(delivery.call_id),
                    "participant_id": str(user_id),
                    "brigade_id": str(delivery.brigade_id),
                    "call_target_id": str(delivery.target_id),
                    "message": delivery.message,
                    "delivered_at": timestamp(delivery.delivered_at),
                },
                "state": "presented" if success else "failed" if failed else "delivered",
                "presented_at": timestamp(success[0].recorded_at) if success else None,
                "presentation_event_id": str(success[1]) if success else None,
                "failed_at": timestamp(failed.recorded_at) if failed else None,
                "failure_reason": failed.payload["reason"] if failed else None,
            }
        )
    # Бригада звонит сама с готовым докладом (27.09). incoming — вызовы, которые
    # сейчас ждут ответа; callbacks — вся история: сколько бригада ждала ответа.
    inbound = list(
        await db.scalars(
            select(Call)
            .where(Call.card_id == card_id, Call.direction == "inbound")
            .order_by(Call.started_at, Call.id)
        )
    )
    incoming = [
        {
            "call_id": str(call.id),
            "brigade_id": str(call.brigade_id),
            "call_target_id": str(call.target_id),
            "started_at": timestamp(call.started_at),
        }
        for call in inbound
        if call.answered_at is None and call.ended_at is None
    ]
    callbacks = [
        {
            "call_id": str(call.id),
            "brigade_id": str(call.brigade_id),
            "call_target_id": str(call.target_id),
            "started_at": timestamp(call.started_at),
            "answered_at": timestamp(call.answered_at) if call.answered_at else None,
            "ended_at": timestamp(call.ended_at) if call.ended_at else None,
        }
        for call in inbound
    ]
    return TrainingView(
        {
            "card_id": str(card_id),
            "revision": state.revision if state else 1,
            "selected_brigade_ids": [str(b) for b in selected],
            "messages": messages,
            "incoming": incoming,
            "callbacks": callbacks,
            **(
                {
                    "available_brigade_ids": [str(b) for b in roster.available],
                    "busy_brigades": [
                        {
                            "brigade_id": str(brigade_id),
                            "card_id": str(busy.card_id),
                            "card_number": busy.card_number,
                        }
                        for brigade_id, busy in roster.busy.items()
                    ],
                }
                if roster is not None
                else {}
            ),
        }
    )


async def get_training(request: Request, card_id: UUID) -> TrainingView:
    # Один согласованный снимок выборки/выдачи/предъявления, в том числе после finish.
    row = await card_repo.card(
        request.state.db, card_id, request.state.user.id, request.state.user.role, lock=True
    )
    if row is None:
        raise HTTPException(404, "Карточка не найдена.")
    view = await training_projection(request.state.db, card_id)
    hint = await awaiting_hint(request.state.db, row["Card"])
    missing = await missing_report_states(
        request.state.db, row["Card"], list(CARD_TRANSITIONS.get(row["Card"].state, ()))
    )
    return TrainingView(
        {**view.root, "awaiting_state": hint, "missing_report_states": sorted(missing)}
    )


async def awaiting_hint(db: AsyncSession, card: Any) -> str | None:
    """Какого статуса ждёт бригада — только в занятии с подсказками.

    План сообщений принадлежит преподавателю; наружу уходит лишь имя статуса, и то
    при hints_level ≥ 1 (тренировка, «уровень чайника»). В контрольном занятии — null.
    """
    if card.closed_at is not None or card.interrupted_at is not None:
        return None
    assignment = await db.get(Assignment, card.assignment_id)
    if assignment is None:
        return None
    lesson = await db.get(Session, assignment.session_id)
    if lesson is None or int(lesson.settings_snapshot.get("hints_level", 0)) < 1:
        return None
    scenario = await db.get(Scenario, assignment.scenario_id)
    if scenario is None:
        return None
    plan = await plan_for_assignment(db, assignment, scenario)
    if plan is None:
        return None
    issued = set(
        (
            await db.execute(
                select(MessageDelivery.message_id, MessageDelivery.message_version).where(
                    MessageDelivery.card_id == card.id
                )
            )
        ).tuples()
    )
    return awaiting_state(plan.plan["messages"], issued, await status_history(db, card.id))
