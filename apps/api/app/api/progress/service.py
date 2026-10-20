"""Ступени обучения обучаемого (29.09): прогресс по его оценённым карточкам.

Правило — evalcore/progress.py. Попытка — последняя версия оценки закрытой карточки;
решение преподавателя «не согласен» с новым баллом главнее. Засчитываются и занятия
преподавателя, и самостоятельные тренировки. Карточка параллельной смены (`parallel_shift`)
идёт в ступень параллельной работы, а не в ступень уровня своего сценария (HQ-032).
Карточка показа курсором (`settings.demo`, HQ-034) — ни в какую ступень.
"""

from dataclasses import dataclass
from typing import Any
from uuid import UUID

from evalcore.progress import (  # type: ignore[import-untyped]
    StepAttempt,
    attempt_passed,
    current_step,
    step_progress,
)
from fastapi import Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.evaluations.repo import latest_overrides
from app.api.progress import schemas
from app.api.progress.advice import WINDOW, advice, previous_advice, recent_attempts
from app.core.models import (
    Assignment,
    Card,
    Evaluation,
    Participant,
    Scenario,
    Session,
    User,
)
from app.core.scored_criteria import applied_critical_flags


def is_tutorial(scenario: Scenario) -> bool:
    from app.api.sessions.practice import audio_scenario_id, tutorial_scenario_id

    # Смена озвучки не отменяет уже пройденное упражнение прежнего поколения Piper.
    return scenario.id in {
        tutorial_scenario_id(scenario.target_service_id),
        audio_scenario_id("tutorial", scenario.target_service_id, voice=None),
    }


def parallel_shift(session: Session, participant: Participant, assignments: int) -> bool:
    """Смена параллельной работы: участнику назначено больше одной карточки и брать их он
    может по две и больше сразу — как планировщик (`worker/scheduler.py`): одновременных
    карточек не больше `parallel_cards` занятия и уровня участника. Признак смены, а не
    того, пересеклись ли карточки на деле: рано закрытая первая карточка параллельной
    тренировки не должна уходить в ступень одиночных карточек."""
    configured = int((session.settings_snapshot or {}).get("parallel_cards", 1))
    return assignments > 1 and min(configured, participant.level) > 1


def final_shift(session: Session) -> bool:
    """Финальная смена (HQ-033, ступень 5): режим смены в снимке настроек занятия."""
    return bool((session.settings_snapshot or {}).get("final_shift", False))


@dataclass(frozen=True)
class ScoredCard:
    """Оценённая закрытая карточка обучаемого: сценарий, итог (балл преподавателя главнее)
    и «зачтено»."""

    card: Card
    scenario: Scenario
    total: float
    passed: bool
    parallel: bool = False
    final: bool = False
    demo: bool = False


async def scored_cards(db: AsyncSession, user_id: UUID) -> list[ScoredCard]:
    rows = (
        await db.execute(
            select(Evaluation, Card, Scenario, Participant, Session)
            .join(Card, Card.id == Evaluation.card_id)
            .join(Assignment, Assignment.id == Card.assignment_id)
            .join(Participant, Participant.id == Assignment.participant_id)
            .join(Session, Session.id == Participant.session_id)
            .join(Scenario, Scenario.id == Assignment.scenario_id)
            .where(Participant.user_id == user_id, Card.closed_at.is_not(None))
            .order_by(Evaluation.card_id, Evaluation.version.desc())
        )
    ).tuples()
    latest: dict[UUID, tuple[Evaluation, Card, Scenario, Participant, Session]] = {}
    for evaluation, card, scenario, participant, session in rows:
        # Без оценки по правилам попытку не засчитываем ни в плюс, ни в минус.
        if evaluation.rules_scores:
            latest.setdefault(card.id, (evaluation, card, scenario, participant, session))
    overrides = await latest_overrides(db, [item[0].id for item in latest.values()])
    participants = {item[3].id for item in latest.values()}
    planned: dict[UUID, int] = {}
    if participants:
        counts = await db.execute(
            select(Assignment.participant_id, func.count(Assignment.id))
            .where(
                Assignment.participant_id.in_(participants),
                Assignment.cancelled_at.is_(None),
            )
            .group_by(Assignment.participant_id)
        )
        planned = {participant_id: int(count) for participant_id, count in counts.tuples()}
    result: list[ScoredCard] = []
    for evaluation, card, scenario, participant, session in latest.values():
        override = overrides.get(evaluation.id)
        teacher_total = (
            float(override.new_total)
            if override is not None
            and override.decision == "disagree"
            and override.new_total is not None
            else None
        )
        result.append(
            ScoredCard(
                card=card,
                scenario=scenario,
                total=float(evaluation.total) if teacher_total is None else teacher_total,
                passed=attempt_passed(
                    float(evaluation.total),
                    bool(applied_critical_flags(evaluation.critical_flags, evaluation.explanation)),
                    teacher_total,
                ),
                parallel=parallel_shift(session, participant, planned.get(participant.id, 0)),
                final=final_shift(session),
                demo=bool((session.settings_snapshot or {}).get("demo", False)),
            )
        )
    return result


async def trainee_attempts(db: AsyncSession, user_id: UUID) -> list[StepAttempt]:
    return [
        StepAttempt(
            level=item.scenario.level,
            tutorial=is_tutorial(item.scenario),
            passed=item.passed,
            parallel=item.parallel,
            final=item.final,
            demo=item.demo,
            at=item.card.closed_at or item.card.appeared_at,  # закрытые — отбор в scored_cards
        )
        for item in await scored_cards(db, user_id)
    ]


async def trainee_progress(db: AsyncSession, user: User) -> schemas.TraineeProgress:
    progress = step_progress(await trainee_attempts(db, user.id))
    step = current_step(progress)
    title = next(item.title for item in progress if item.number == step)
    recent = await recent_attempts(db, user.id)
    recommendation = advice([item.scores for item in recent[:WINDOW]], step, title)
    if recommendation is not None:
        recommendation["previous"] = previous_advice(recent)
    from app.api.progress.repeats import repeats

    return schemas.TraineeProgress(
        user_id=user.id,
        full_name=user.full_name,
        current_step=step,
        advice=schemas.Advice.model_validate(recommendation) if recommendation else None,
        steps=[
            schemas.StepProgressView.model_validate(item, from_attributes=True) for item in progress
        ],
        repeats=[
            schemas.ScenarioRepeat.model_validate(item)
            for item in await repeats(db, user.id, progress)
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
