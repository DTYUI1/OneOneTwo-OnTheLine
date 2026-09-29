"""Единственный планировщик появления карточек (ADR-11)."""

import math
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from evalcore.adaptive import predict  # type: ignore[import-untyped]
from evalcore.models import Trainee  # type: ignore[import-untyped]
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.api.notifications import notify
from app.core.models import Assignment, Card, Participant, Prediction, Scenario, Session


def fallback_prediction(theta: float, weight: int, normative_s: int) -> dict[str, Any]:
    """Временная воспроизводимая IRT-1PL до реализации evalcore T-022."""
    difficulty = (weight - 5.5) / 2.25
    p_success = 1.0 / (1.0 + math.exp(-(theta - difficulty)))
    expected_time = normative_s * (1.35 - 0.7 * p_success)
    return {
        "p_success": p_success,
        "expected_score": p_success,
        "expected_time_s": expected_time,
        "p_timeout": 1.0 / (1.0 + math.exp(-(expected_time - normative_s) / 30.0)),
        "model_version": "worker-irt-fallback-v1",
        "b_scenario": difficulty,
    }


def make_prediction(
    participant: Participant, scenario: Scenario, settings: dict[str, Any]
) -> dict[str, Any]:
    normative_s = int(settings.get("handling_normative_s", 180))
    scenario_value: dict[str, Any] = {
        "id": str(scenario.id),
        "version": scenario.version,
        "level": scenario.level,
        "weight": scenario.weight,
        "incident_type_code": scenario.incident_type_code,
        "target_service_id": scenario.target_service_id,
        "card": scenario.card,
        "reference": scenario.reference,
        "complications": scenario.complications,
    }
    try:
        result = predict(
            Trainee(
                theta=participant.rating_at_start,
                log_time_mean=math.log(max(1, normative_s)),
                log_time_variance=0.25,
            ),
            scenario_value,
        )
    except NotImplementedError:
        return fallback_prediction(participant.rating_at_start, scenario.weight, normative_s)
    return {
        "p_success": result.p_success,
        "expected_score": result.expected_score,
        "expected_time_s": result.expected_time_s,
        "p_timeout": result.p_timeout,
        "model_version": result.model_version,
        "b_scenario": (scenario.weight - 5.5) / 2.25,
    }


class CardScheduler:
    def __init__(self, sessions: async_sessionmaker[AsyncSession], *, batch_size: int = 23) -> None:
        self.sessions = sessions
        self.batch_size = batch_size

    async def tick(self, now: datetime | None = None) -> int:
        now = now or datetime.now(UTC)
        created = 0
        async with self.sessions() as db:
            session_ids = list(
                (
                    await db.scalars(
                        select(Session.id).where(Session.status == "running").order_by(Session.id)
                    )
                ).all()
            )
        for session_id in session_ids:
            if created >= self.batch_size:
                break
            created += await self._issue_session(session_id, now, self.batch_size - created)
        return created

    async def _issue_session(self, session_id: UUID, now: datetime, limit: int) -> int:
        created = 0
        async with self.sessions.begin() as db:
            # Session всегда первая: finish и учебные действия используют тот же порядок.
            # SKIP LOCKED позволяет другой реплике обслуживать независимое занятие.
            lesson = await db.scalar(
                select(Session)
                .where(
                    Session.id == session_id,
                    Session.status == "running",
                )
                .with_for_update(skip_locked=True)
            )
            if lesson is None:
                return 0
            due = func.coalesce(Assignment.due_at, Assignment.planned_at)
            assignments = list(
                (
                    await db.scalars(
                        select(Assignment)
                        .where(
                            Assignment.session_id == session_id,
                            Assignment.status == "pending",
                            Assignment.cancelled_at.is_(None),
                            due <= now,
                            ~select(Card.id).where(Card.assignment_id == Assignment.id).exists(),
                        )
                        .order_by(due, Assignment.order, Assignment.id)
                        .with_for_update()
                    )
                ).all()
            )
            for assignment in assignments:
                if created >= limit:
                    break
                participant = await db.get(Participant, assignment.participant_id)
                scenario = await db.get(Scenario, assignment.scenario_id)
                if participant is None or scenario is None:
                    continue
                configured = int(lesson.settings_snapshot.get("parallel_cards", 1))
                capacity = max(1, min(configured, participant.level))
                active = int(
                    await db.scalar(
                        select(func.count())
                        .select_from(Card)
                        .join(Assignment, Assignment.id == Card.assignment_id)
                        .where(
                            Assignment.participant_id == participant.id,
                            Card.closed_at.is_(None),
                            Card.interrupted_at.is_(None),
                            # Окончательная «Не принята» — терминал обработки (I-TIME v3):
                            # решение принято, место под следующую карточку свободно.
                            Card.state != "rejected",
                            Assignment.session_id == session_id,
                        )
                    )
                    or 0
                )
                if active >= capacity:
                    continue
                existing = await db.scalar(
                    select(Card.id).where(Card.assignment_id == assignment.id)
                )
                if existing is not None:
                    continue
                card = Card(
                    assignment_id=assignment.id,
                    number=str(scenario.card["number"]),
                    state="added",
                    appeared_at=now,
                    delivered_at=None,
                    opened_at=None,
                    first_status_at=None,
                    closed_at=None,
                    current={"service_number": "", "comment": ""},
                    redirected_to_service_id=None,
                )
                db.add(card)
                await db.flush()
                forecast = make_prediction(participant, scenario, lesson.settings_snapshot)
                db.add(
                    Prediction(
                        card_id=card.id,
                        participant_id=participant.id,
                        made_at=now,
                        p_success=forecast["p_success"],
                        expected_score=forecast["expected_score"],
                        p_timeout=forecast["p_timeout"],
                        expected_time_s=forecast["expected_time_s"],
                        theta_before=participant.rating_at_start,
                        b_scenario=forecast["b_scenario"],
                        model_version=forecast["model_version"],
                        actual_score=None,
                        actual_time_s=None,
                        actual_timeout=None,
                    )
                )
                # assignment остаётся pending до клиентского ACK deliver; иначе публичный
                # статус сообщал бы доставку раньше фактического показа строки.
                await db.flush()
                await notify(db, "card.appeared", card.id)
                created += 1
        return created
