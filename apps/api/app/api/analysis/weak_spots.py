"""Ошибки навыков за последние пять завершённых занятий, без разбора текста evidence."""

from collections import defaultdict
from typing import Any
from uuid import UUID

from evalcore.brigade import event_score, fired_events  # type: ignore[import-untyped]
from evalcore.models import EvalContext  # type: ignore[import-untyped]
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.training.scenario_events import evaluation_events
from app.core.evaluation_details import call_context
from app.core.models import Assignment, Call, Card, Evaluation, Participant, Session
from app.core.scored_criteria import applied_scores

KINDS = {"readback_error", "request_service", "silence", "clarify"}


def aggregate(samples: list[tuple[str, float]]) -> dict[str, Any]:
    """Провал — балл ниже 1, включая поздний ответ; знаменатель — только оценённые случаи."""
    scores: dict[str, list[float]] = defaultdict(list)
    for skill, score in samples:
        scores[skill].append(score)
    return {
        skill: {
            "failed": sum(s < 1 for s in values),
            "total": len(values),
            "rate": sum(s < 1 for s in values) / len(values),
        }
        for skill, values in sorted(scores.items())
    }


def event_samples(context: EvalContext) -> list[tuple[str, float]]:
    """brigade_work объединяет навыки: разделяем по типу реально сработавшего события."""
    return [
        (str(item.event["kind"]), score)
        for item in fired_events(context)
        if not item.fallback
        and item.event["kind"] in KINDS
        and (score := event_score(item.outcome, item.event)) is not None
    ]


async def profile(db: AsyncSession, user_id: UUID) -> dict[str, Any]:
    lessons = (
        select(Session.id)
        .join(Participant, Participant.session_id == Session.id)
        .where(
            Participant.user_id == user_id,
            Session.kind == "lesson",
            Session.status == "finished",
            Session.finished_at.is_not(None),
        )
        .order_by(Session.finished_at.desc(), Session.id)
        .limit(5)
    )
    rows = (
        await db.execute(
            select(Card, Evaluation, Session)
            .join(Assignment, Assignment.id == Card.assignment_id)
            .join(Participant, Participant.id == Assignment.participant_id)
            .join(Session, Session.id == Assignment.session_id)
            .join(Evaluation, Evaluation.card_id == Card.id)
            .where(
                Participant.user_id == user_id,
                Session.id.in_(lessons),
                Card.closed_at.is_not(None),
                Evaluation.rules_scores != {},
            )
            .order_by(Card.id, Evaluation.version.desc())
        )
    ).all()
    samples: list[tuple[str, float]] = []
    seen = set()
    for card, evaluation, lesson in rows:
        if card.id in seen:
            continue
        seen.add(card.id)
        weights = lesson.settings_snapshot.get("weights", {})
        scores = applied_scores(evaluation.rules_scores, evaluation.explanation, weights)
        if "reaction_time" in scores:
            samples.append(("reaction_time", scores["reaction_time"]))
        if "brigade_work" not in scores:
            continue
        calls = await db.scalars(select(Call).where(Call.card_id == card.id))
        context = EvalContext(
            scenario={},
            current=card.current,
            events=[],
            calls=[call_context(c) for c in calls],
            settings=lesson.settings_snapshot,
            scenario_events=await evaluation_events(db, card),
        )
        samples.extend(event_samples(context))
    return aggregate(samples)
