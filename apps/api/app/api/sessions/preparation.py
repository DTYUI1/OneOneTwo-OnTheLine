"""Подготовка ИИ-занятия: история → recommend_level → ограниченный пакет → назначения."""

from typing import Any
from uuid import UUID, uuid5

from evalcore.adaptive import recommend_level  # type: ignore[import-untyped]
from fastapi import HTTPException
from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.analysis.service import build_attempt, observation
from app.api.cards.repo import card_query
from app.api.sessions import repo, schemas
from app.core.ai_resource import generation_state
from app.core.models import (
    Assignment,
    AuditLog,
    Card,
    Evaluation,
    Job,
    Participant,
    Scenario,
    ScenarioPack,
    Session,
)
from app.core.scored_criteria import applied_critical_flags
from app.worker.generators.themes import warnings as theme_warnings
from app.worker.generators.validation import SERVICES
from app.worker.queue import enqueue_job


async def recommend_for_participant(db: AsyncSession, participant: Participant) -> Any:
    """Тот же V-03 по пяти последним закрытым оценённым попыткам той же службы.

    build_attempt учитывает последнюю версию оценки и действующее переопределение,
    observation использует снимок норматива попытки. θ и ступени здесь не подменяют уровень.
    """
    rows = list(
        (
            await db.execute(
                card_query()
                .where(
                    Participant.user_id == participant.user_id,
                    Scenario.target_service_id == participant.dds_service_id,
                    Card.closed_at.is_not(None),
                    exists(
                        select(Evaluation.id).where(
                            Evaluation.card_id == Card.id, Evaluation.rules_scores != {}
                        )
                    ),
                )
                .order_by(Card.closed_at.desc(), Card.id)
                .limit(5)
            )
        ).mappings()
    )
    history, flags = [], {}
    for row in rows:
        card = row["Card"]
        assignment = await db.get(Assignment, card.assignment_id)
        if assignment is None:
            raise RuntimeError("У закрытой попытки отсутствует назначение.")
        scenario = await db.get(Scenario, assignment.scenario_id)
        if scenario is None:
            raise RuntimeError("У закрытой попытки отсутствует сценарий.")
        # Начатая переоценка без rules не отменяет уже завершённую оценённую попытку.
        evaluation = await db.scalar(
            select(Evaluation)
            .where(
                Evaluation.card_id == card.id,
                Evaluation.rules_scores != {},
            )
            .order_by(Evaluation.version.desc())
            .limit(1)
        )
        if evaluation is None or not evaluation.rules_scores:
            continue
        attempt = await build_attempt(db, row, evaluation_override=evaluation)
        history.append(observation(attempt, card, scenario.level, scenario.weight))
        flags[str(card.id)] = applied_critical_flags(
            evaluation.critical_flags or [], evaluation.explanation
        )
    return recommend_level(participant.level, history, critical_flags_by_card=flags)


async def recommend_for_user(db: AsyncSession, user_id: UUID, service_id: str) -> Any:
    """Рекомендация Студии: последняя ступень пользователя по выбранной службе."""
    previous = await db.scalar(
        select(Participant)
        .join(Session, Session.id == Participant.session_id)
        .where(
            Participant.user_id == user_id,
            Participant.dds_service_id == service_id,
            Session.started_at.is_not(None),
        )
        .order_by(Session.started_at.desc(), Session.id)
        .limit(1)
    )
    participant = Participant(
        user_id=user_id, dds_service_id=service_id, level=previous.level if previous else 1
    )
    return await recommend_for_participant(db, participant)


async def initialize_preparation(
    db: AsyncSession,
    lesson: Session,
    selection: schemas.AISelection,
) -> None:
    if lesson.kind != "lesson" or any(
        p.dds_service_id not in SERVICES for p in lesson.participants
    ):
        raise HTTPException(422, "ИИ-подбор доступен для занятий и шести поддерживаемых служб.")
    pack_id = uuid5(lesson.id, "ai-pack")
    db.add(
        ScenarioPack(
            id=pack_id,
            title=f"ИИ-задания: {lesson.title}",
            status="draft",
            origin="template",
            created_by=lesson.teacher_id,
        )
    )
    await db.flush()
    items: list[dict[str, Any]] = []
    recommendations: list[schemas.AIParticipantRecommendation] = []
    base_seed = lesson.id.int % 1_000_000
    for participant in sorted(lesson.participants, key=lambda p: p.workstation_id):
        recommended = await recommend_for_participant(db, participant)
        participant.level = recommended.level
        recommendations.append(
            schemas.AIParticipantRecommendation.model_validate(
                {
                    "user_id": str(participant.user_id),
                    "service_id": participant.dds_service_id,
                    "level": recommended.level,
                    "weight": recommended.weight,
                    "based_on_attempts": recommended.based_on_attempts,
                    "explanation": recommended.explanation,
                }
            )
        )
        from app.api.analysis.weak_spots import profile
        from app.worker.generators.personalization import focus_orders

        weak = await profile(db, participant.user_id)
        focused = focus_orders(selection.cards_per_participant, base_seed + len(items))
        for order in range(1, selection.cards_per_participant + 1):
            items.append(
                {
                    "participant_id": str(participant.user_id),
                    "service_id": participant.dds_service_id,
                    "level": recommended.level,
                    "weight": recommended.weight,
                    "seed": base_seed + len(items),
                    "order": order,
                    "weak_spots": weak,
                    "focus": order in focused,
                }
            )
    job = await enqueue_job(
        db,
        kind="generate",
        entity_id=lesson.id,
        payload={
            "pack_id": str(pack_id),
            "session_id": str(lesson.id),
            "auto_admit": True,
            "count": len(items),
            "level": 1,
            "service_id": lesson.participants[0].dds_service_id,
            "seed": base_seed,
            "items": items,
            "generation_policy": selection.generation_policy,
            "categories": selection.categories,
        },
    )
    lesson.ai_preparation = schemas.AIPreparation(
        job_id=job.id,
        state="queued",
        cards_per_participant=selection.cards_per_participant,
        completed=0,
        total=len(items),
        warnings=theme_warnings(job.payload),
        recommendations=recommendations,
    ).model_dump(mode="json")


async def preparation_view(
    db: AsyncSession, lesson: Session, *, local_ai: bool = True
) -> dict[str, Any] | None:
    # Контрактное null возвращает кабинет к ручной раздаче; Job хранит итог stop.
    if lesson.ai_preparation is None or lesson.ai_preparation["state"] == "cancelled":
        return None
    value = dict(lesson.ai_preparation)
    job = await db.get(Job, UUID(value["job_id"]))
    if job is None or job.status == "failed":
        value["state"] = "failed"
        value["warnings"] = [job.error if job and job.error else "Подготовка недоступна."]
    elif job.status == "cancelled":
        value["state"] = "cancelled"
    elif value["state"] != "ready":
        value["state"] = await generation_state(db, job, local_ai=local_ai)
    return value


async def update_preparation_progress(
    db: AsyncSession, payload: dict[str, Any], completed: int, fallback_count: int
) -> None:
    lesson = await repo.get_session(db, UUID(payload["session_id"]), lock=True)
    if lesson is None or lesson.ai_preparation is None or lesson.status != "draft":
        raise ValueError("Подготовка отменена: занятие недоступно или уже завершено.")
    lesson.ai_preparation = {
        **lesson.ai_preparation,
        "state": "generating",
        "completed": completed,
        "warnings": theme_warnings(payload)
        + (
            [
                f"Шаблонная замена: {fallback_count} из {completed} подготовленных. "
                "ИИ не создал эти задания; использован проверенный шаблон."
            ]
            if fallback_count
            else []
        ),
    }


async def finalize_preparation(
    db: AsyncSession, payload: dict[str, Any], scenario_ids: list[str], fallback_count: int
) -> None:
    from app.api.sessions.batches import AssignmentBatchInput, store_batch

    lesson = await repo.get_session(db, UUID(payload["session_id"]), lock=True)
    if (
        lesson is not None
        and lesson.ai_preparation is not None
        and lesson.ai_preparation["state"] == "ready"
    ):
        return
    if lesson is None or lesson.ai_preparation is None or lesson.status != "draft":
        raise ValueError("Подготовка отменена: занятие недоступно или уже завершено.")
    items = payload["items"]
    if len(items) != len(scenario_ids) or len(items) != lesson.ai_preparation["total"]:
        raise ValueError("Подготовлен не весь набор заданий.")
    await store_batch(
        db,
        lesson,
        lesson.teacher_id,
        AssignmentBatchInput(
            {
                "request_id": str(uuid5(lesson.id, "ai-assignments")),
                "items": [
                    {
                        "participant_id": item["participant_id"],
                        "scenario_id": scenario_id,
                        "scenario_version": 1,
                        "order": item["order"],
                        "delay_from_start_s": (item["order"] - 1) * 60,
                        "delivery_mode": "profile",
                    }
                    for item, scenario_id in zip(items, scenario_ids, strict=True)
                ],
            }
        ),
    )
    lesson.ai_preparation = {
        **lesson.ai_preparation,
        "state": "ready",
        "completed": len(items),
        "warnings": theme_warnings(payload)
        + (
            [
                f"Шаблонная замена: {fallback_count} из {len(items)}. "
                "ИИ не создал эти задания; использован проверенный шаблон."
            ]
            if fallback_count
            else []
        ),
    }
    db.add(
        AuditLog(
            actor_id=lesson.teacher_id,
            action="createAssignmentBatch",
            entity="session",
            entity_id=str(lesson.id),
            before=None,
            after={"automatic": True, "count": len(items), "fallback_count": fallback_count},
            ip=None,
        )
    )
