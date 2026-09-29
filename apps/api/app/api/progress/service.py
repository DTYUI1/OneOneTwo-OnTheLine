"""Ступени обучения обучаемого (29.09): прогресс по его оценённым карточкам.

Правило — evalcore/progress.py. Попытка — последняя версия оценки закрытой карточки;
решение преподавателя «не согласен» с новым баллом главнее. Засчитываются и занятия
преподавателя, и самостоятельные тренировки.
"""

from typing import Any
from uuid import UUID

from evalcore.progress import (  # type: ignore[import-untyped]
    StepAttempt,
    attempt_passed,
    current_step,
    step_progress,
)
from fastapi import Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.evaluations.repo import latest_overrides
from app.api.progress import schemas
from app.core.models import Assignment, Card, Evaluation, Participant, Scenario, User


def is_tutorial(scenario: Scenario) -> bool:
    from app.api.sessions.practice import tutorial_scenario_id

    return scenario.id == tutorial_scenario_id(scenario.target_service_id)


async def trainee_attempts(db: AsyncSession, user_id: UUID) -> list[StepAttempt]:
    rows = (
        await db.execute(
            select(Evaluation, Card, Scenario)
            .join(Card, Card.id == Evaluation.card_id)
            .join(Assignment, Assignment.id == Card.assignment_id)
            .join(Participant, Participant.id == Assignment.participant_id)
            .join(Scenario, Scenario.id == Assignment.scenario_id)
            .where(Participant.user_id == user_id, Card.closed_at.is_not(None))
            .order_by(Evaluation.card_id, Evaluation.version.desc())
        )
    ).tuples()
    latest: dict[UUID, tuple[Evaluation, Card, Scenario]] = {}
    for evaluation, card, scenario in rows:
        # Без оценки по правилам попытку не засчитываем ни в плюс, ни в минус.
        if evaluation.rules_scores:
            latest.setdefault(card.id, (evaluation, card, scenario))
    overrides = await latest_overrides(db, [item[0].id for item in latest.values()])
    attempts: list[StepAttempt] = []
    for evaluation, card, scenario in latest.values():
        override = overrides.get(evaluation.id)
        teacher_total = (
            float(override.new_total)
            if override is not None
            and override.decision == "disagree"
            and override.new_total is not None
            else None
        )
        attempts.append(
            StepAttempt(
                level=scenario.level,
                tutorial=is_tutorial(scenario),
                passed=attempt_passed(
                    float(evaluation.total), bool(evaluation.critical_flags), teacher_total
                ),
                at=card.closed_at or card.appeared_at,  # закрытые — отбор выше
            )
        )
    return attempts


async def trainee_progress(db: AsyncSession, user: User) -> schemas.TraineeProgress:
    progress = step_progress(await trainee_attempts(db, user.id))
    return schemas.TraineeProgress(
        user_id=user.id,
        full_name=user.full_name,
        current_step=current_step(progress),
        steps=[
            schemas.StepProgressView.model_validate(item, from_attributes=True) for item in progress
        ],
    )


async def list_progress(request: Request) -> list[schemas.TraineeProgress]:
    """Обучаемому — свой путь; преподавателю — путь всех действующих обучаемых."""
    db: AsyncSession = request.state.db
    user = request.state.user
    if user.role == "trainee":
        return [await trainee_progress(db, user)]
    trainees: Any = await db.scalars(
        select(User).where(User.role == "trainee", User.is_active.is_(True)).order_by(User.login)
    )
    return [await trainee_progress(db, trainee) for trainee in trainees]
