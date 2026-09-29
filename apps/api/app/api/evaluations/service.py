import csv
import io
from datetime import datetime
from statistics import fmean
from typing import Any, cast
from uuid import UUID, uuid4

from evalcore.models import EvalContext  # type: ignore[import-untyped]
from evalcore.scoring import evaluate  # type: ignore[import-untyped]
from fastapi import HTTPException, Request, Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.evaluations import repo, schemas
from app.api.notifications import notify
from app.api.training.content import plan_for_assignment
from app.api.training.status_evidence import justified_state
from app.core.evaluation_details import (
    DEFAULT_EXPLANATION,
    call_context,
    pack_explanations,
    unpack_explanation,
)
from app.core.models import (
    Assignment,
    Call,
    Card,
    CardEvent,
    MessageDelivery,
    MessagePresentation,
    Participant,
    Prediction,
    RoutingRule,
    Scenario,
    Session,
    Street,
    TeacherOverride,
)
from app.core.models import (
    Evaluation as EvaluationRow,
)
from app.core.spelling import for_scenario
from app.worker.queue import enqueue_job


def criteria_for(row: Any) -> list[schemas.CriterionResult]:
    evaluation: EvaluationRow = row["Evaluation"]
    settings = row["settings_snapshot"]
    weights = settings.get("weights", {}) if isinstance(settings, dict) else {}
    explanations = evaluation.explanation if isinstance(evaluation.explanation, dict) else {}
    scores: dict[str, float] = {}
    for layer in (evaluation.rules_scores, evaluation.semantic_scores, evaluation.llm_scores):
        if isinstance(layer, dict):
            scores.update({str(key): float(value) for key, value in layer.items()})
    criteria = []
    for key, score in sorted(scores.items()):
        explanation, evidence = unpack_explanation(explanations.get(key, DEFAULT_EXPLANATION))
        criteria.append(
            schemas.CriterionResult(
                key=key,
                score=score,
                weight=float(weights.get(key, 1)),
                critical=key in evaluation.critical_flags,
                evidence=evidence,
                explanation=explanation,
            )
        )
    return criteria


def serialize(row: Any, override: TeacherOverride | None = None) -> schemas.Evaluation:
    evaluation: EvaluationRow = row["Evaluation"]
    total = (
        override.new_total
        if override is not None and override.decision == "disagree"
        else evaluation.total
    )
    return schemas.Evaluation(
        id=evaluation.id,
        card_id=evaluation.card_id,
        trainee_id=row["trainee_id"],
        version=evaluation.version,
        status=cast(Any, evaluation.status),
        total=float(total if total is not None else evaluation.total),
        criteria=criteria_for(row),
        model_info={str(key): str(value) for key, value in evaluation.model_info.items()},
        teacher_comment=override.teacher_comment if override is not None else "",
    )


async def list_evaluations(request: Request) -> list[schemas.Evaluation]:
    rows = await repo.evaluations(request.state.db, request.state.user.id, request.state.user.role)
    overrides = await repo.latest_overrides(
        request.state.db, [row["Evaluation"].id for row in rows]
    )
    return [serialize(row, overrides.get(row["Evaluation"].id)) for row in rows]


async def get_evaluation(request: Request, evaluation_id: UUID) -> schemas.Evaluation:
    row = await repo.evaluation(
        request.state.db,
        evaluation_id,
        request.state.user.id,
        request.state.user.role,
    )
    if row is None:
        raise HTTPException(404, "Оценка не найдена.")
    override = (await repo.latest_overrides(request.state.db, [evaluation_id])).get(evaluation_id)
    return serialize(row, override)


async def create_override(request: Request, body: schemas.OverrideInput) -> schemas.Evaluation:
    row = await repo.evaluation(
        request.state.db,
        body.evaluation_id,
        request.state.user.id,
        request.state.user.role,
        lock=True,
    )
    if row is None:
        raise HTTPException(404, "Оценка не найдена.")
    previous = (await repo.latest_overrides(request.state.db, [body.evaluation_id])).get(
        body.evaluation_id
    )
    request.state.audit_before = serialize(row, previous).model_dump(mode="json")
    override = TeacherOverride(
        id=uuid4(),
        evaluation_id=body.evaluation_id,
        teacher_id=request.state.user.id,
        decision=body.decision,
        new_total=body.new_total,
        criterion_patches={},
        reason=body.reason,
        teacher_comment=body.teacher_comment,
    )
    request.state.db.add(override)
    await request.state.db.flush()
    request.state.entity = "teacher_override"
    request.state.entity_id = str(override.id)
    result = serialize(row, override)
    request.state.audit_after = result.model_dump(mode="json")
    await notify(request.state.db, "evaluation." + row["Evaluation"].status, body.evaluation_id)
    return result


async def planned_messages(
    db: AsyncSession, card: Card, assignment: Assignment, scenario: Scenario
) -> tuple[dict[str, Any], ...]:
    """Доклады плана и момент их первого подтверждённого предъявления (message_presented)."""
    plan = await plan_for_assignment(db, assignment, scenario)
    if plan is None:
        return ()
    presented = dict(
        (
            await db.execute(
                select(MessageDelivery.message_id, func.min(MessagePresentation.recorded_at))
                .join(MessagePresentation, MessagePresentation.delivery_id == MessageDelivery.id)
                .where(
                    MessageDelivery.card_id == card.id,
                    MessagePresentation.kind == "message_presented",
                )
                .group_by(MessageDelivery.message_id)
            )
        )
        .tuples()
        .all()
    )
    result = []
    for planned in plan.plan["messages"]:
        presented_at = presented.get(UUID(planned["message"]["id"]))
        result.append(
            {
                "message_id": planned["message"]["id"],
                "justifies_state": justified_state(planned, scenario.id),
                "presented_at": presented_at.isoformat() if presented_at else None,
            }
        )
    return tuple(result)


async def evaluation_context(
    db: AsyncSession, card_id: UUID
) -> tuple[EvalContext, Card, Participant, Session]:
    found = (
        await db.execute(
            select(Card, Assignment, Participant, Scenario, Session)
            .join(Assignment, Assignment.id == Card.assignment_id)
            .join(Participant, Participant.id == Assignment.participant_id)
            .join(Scenario, Scenario.id == Assignment.scenario_id)
            .join(Session, Session.id == Assignment.session_id)
            .where(Card.id == card_id)
        )
    ).one()
    card, assignment, participant, scenario, lesson = found
    events = list(
        (
            await db.scalars(
                select(CardEvent)
                .where(CardEvent.card_id == card_id)
                .order_by(CardEvent.server_ts, CardEvent.id)
            )
        ).all()
    )
    # Входящие от бригады — не решение диспетчера: адресата звонка оценивают по исходящим.
    calls = list(
        (
            await db.scalars(
                select(Call).where(Call.card_id == card_id, Call.direction == "outbound")
            )
        ).all()
    )
    streets = tuple((await db.scalars(select(Street.name))).all())
    routing = list((await db.scalars(select(RoutingRule))).all())
    context = EvalContext(
        scenario={
            "id": str(scenario.id),
            "version": scenario.version,
            "level": scenario.level,
            "weight": scenario.weight,
            "incident_type_code": scenario.incident_type_code,
            "target_service_id": scenario.target_service_id,
            "card": scenario.card,
            "reference": scenario.reference,
            "complications": scenario.complications,
            "origin": scenario.origin,
            "status": scenario.status,
            "teacher_comment": scenario.teacher_comment,
        },
        current=card.current,
        events=[
            {
                "client_event_id": str(item.client_event_id),
                "client_ts": item.client_ts.isoformat(),
                "server_ts": item.server_ts.isoformat(),
                "clock_offset_ms": item.clock_offset_ms,
                "type": item.type,
                "payload": item.payload,
            }
            for item in events
        ],
        calls=[call_context(item) for item in calls],
        settings=lesson.settings_snapshot,
        streets=streets,
        text_checker=for_scenario(streets, scenario.card, scenario.reference),
        routing_rules=tuple(
            {
                "incident_type_code": item.incident_type_code,
                "service_id": item.service_id,
                "condition": item.condition,
                "payload": item.payload,
            }
            for item in routing
        ),
        planned_messages=await planned_messages(db, card, assignment, scenario),
    )
    return context, card, participant, lesson


async def evaluate_terminal_card(db: AsyncSession, card_id: UUID) -> EvaluationRow:
    """Создать мгновенную partial-оценку и фоновую задачу в транзакции terminal event."""
    existing = await db.scalar(
        select(EvaluationRow)
        .where(EvaluationRow.card_id == card_id)
        .order_by(EvaluationRow.version.desc())
    )
    if existing is not None:
        return existing
    context, card, _, lesson = await evaluation_context(db, card_id)
    # V-01: критерии времени — по той же методике занятия, что разбор попытки.
    from app.api.analysis.service import card_timing

    timing = await card_timing(db, card, lesson)
    try:
        evaluated = evaluate(context, timing=timing)
    except NotImplementedError:
        rules_available = False
        rules_scores: dict[str, float] = {}
        total = 0.0
        critical_flags: list[str] = []
        explanation: dict[str, Any] = {
            "rules": "Оценка по правилам недоступна: evalcore T-006 ещё не реализован."
        }
        model_info = {"rules": "unavailable:T-006", "semantic": "pending", "llm": "pending"}
    else:
        rules_available = True
        rules_scores = {item.key: float(item.score) for item in evaluated.criteria}
        total = float(evaluated.total)
        critical_flags = [str(item) for item in evaluated.critical_flags]
        explanation = pack_explanations(evaluated.criteria)
        model_info = {"rules": "evalcore", "semantic": "pending", "llm": "pending"}
    version = (
        int(
            await db.scalar(
                select(func.coalesce(func.max(EvaluationRow.version), 0)).where(
                    EvaluationRow.card_id == card_id
                )
            )
            or 0
        )
        + 1
    )
    evaluation = EvaluationRow(
        id=uuid4(),
        card_id=card_id,
        version=version,
        rules_scores=rules_scores,
        semantic_scores=None,
        llm_scores=None,
        total=total,
        critical_flags=critical_flags,
        explanation=explanation,
        model_info=model_info,
        status="partial",
    )
    db.add(evaluation)
    await db.flush()
    prediction = await db.scalar(
        select(Prediction).where(Prediction.card_id == card_id).with_for_update()
    )
    if (
        rules_available
        and prediction is not None
        and prediction.actual_score is None
        and card.closed_at is not None
    ):
        # Как в отчёте: от появления на АРМ, а не от выдачи scheduler'ом.
        shown_at = card.delivered_at or card.appeared_at
        actual_time = max(0.0, (card.closed_at - shown_at).total_seconds())
        normative = float(lesson.settings_snapshot.get("handling_normative_s", 180))
        prediction.actual_score = total
        prediction.actual_time_s = actual_time
        prediction.actual_timeout = actual_time > normative
        await db.flush()
    await notify(db, "evaluation.partial", evaluation.id)
    await enqueue_job(
        db,
        kind="evaluate",
        payload={"card_id": str(card_id), "evaluation_id": str(evaluation.id)},
        entity_id=evaluation.id,
        version=evaluation.version,
    )
    return evaluation


def elapsed(start: datetime | None, end: datetime | None) -> float | None:
    if start is None or end is None:
        return None
    return max(0.0, (end - start).total_seconds())


async def build_report(request: Request, session_id: UUID) -> schemas.Report:
    lesson = await repo.report_session(
        request.state.db, session_id, request.state.user.id, request.state.user.role
    )
    if lesson is None:
        raise HTTPException(404, "Занятие не найдено.")
    participants = await repo.report_participants(request.state.db, session_id)
    cards = await repo.report_cards(request.state.db, session_id)
    evaluation_rows = await repo.report_evaluations(request.state.db, session_id)
    latest_by_card: dict[UUID, Any] = {}
    for row in evaluation_rows:
        latest_by_card.setdefault(row["Evaluation"].card_id, row)
    overrides = await repo.latest_overrides(
        request.state.db, [row["Evaluation"].id for row in latest_by_card.values()]
    )
    cards_by_participant: dict[UUID, list[Card]] = {}
    for row in cards:
        cards_by_participant.setdefault(row["participant_id"], []).append(row["Card"])
    criterion_scores: dict[str, list[float]] = {}
    trainee_rows: list[schemas.TraineeReport] = []
    for row in participants:
        participant: Participant = row["Participant"]
        own_cards = cards_by_participant.get(participant.id, [])
        views = []
        for card in own_cards:
            evaluation_row = latest_by_card.get(card.id)
            if evaluation_row is not None:
                evaluation = evaluation_row["Evaluation"]
                views.append(serialize(evaluation_row, overrides.get(evaluation.id)))
        reactions = [
            value
            for card in own_cards
            if (value := elapsed(card.delivered_at or card.appeared_at, card.first_status_at))
            is not None
        ]
        handling = [
            value
            for card in own_cards
            if (value := elapsed(card.delivered_at or card.appeared_at, card.closed_at)) is not None
        ]
        for view in views:
            for criterion in view.criteria:
                criterion_scores.setdefault(criterion.key, []).append(criterion.score)
        trainee_rows.append(
            schemas.TraineeReport(
                user_id=participant.user_id,
                full_name=row["full_name"],
                workstation_number=participant.workstation_id,
                total=fmean(item.total for item in views) if views else None,
                reaction_time_s=fmean(reactions) if reactions else None,
                handling_time_s=fmean(handling) if handling else None,
                errors=sum(item.score < 1 for view in views for item in view.criteria),
                level=participant.level,
            )
        )
    weakest = sorted(
        criterion_scores,
        key=lambda key: (fmean(criterion_scores[key]), key),
    )[:3]
    predictions = [
        schemas.PredictionFact(
            card_id=row.card_id,
            p_success=row.p_success,
            expected_score=row.expected_score,
            expected_time_s=row.expected_time_s,
            actual_score=row.actual_score,
            actual_time_s=row.actual_time_s,
        )
        for row in await repo.report_predictions(request.state.db, session_id)
    ]
    return schemas.Report(
        session_id=session_id,
        trainees=trainee_rows,
        weakest_criteria=weakest,
        predictions=predictions,
    )


async def get_session_report(request: Request, session_id: UUID) -> schemas.Report:
    return await build_report(request, session_id)


async def export_session_csv(request: Request, session_id: UUID) -> Response:
    report = await build_report(request, session_id)
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, delimiter=";", lineterminator="\r\n")
    writer.writerow(
        [
            "ФИО",
            "АРМ",
            "Балл",
            "Время реакции, с",
            "Время обработки, с",
            "Ошибки",
            "Уровень",
        ]
    )
    for row in report.trainees:
        writer.writerow(
            [
                row.full_name,
                row.workstation_number,
                # Пустая ячейка — «не оценивалось», как в интерфейсе; 0 — настоящий ноль.
                "" if row.total is None else row.total,
                "" if row.reaction_time_s is None else row.reaction_time_s,
                "" if row.handling_time_s is None else row.handling_time_s,
                row.errors,
                row.level,
            ]
        )
    return Response(
        content="\ufeff" + stream.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="session-{session_id}.csv"'},
    )
