from datetime import UTC, datetime, timedelta
from typing import Any, cast
from uuid import UUID

from fastapi import HTTPException, Request
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.api.c01 import DEFAULT_TIMING_POLICY
from app.api.notifications import notify
from app.api.scenarios.service import ensure_evaluable
from app.api.sessions import repo, schemas
from app.core.models import (
    Assignment,
    Participant,
    Scenario,
    Service,
    Session,
    TraineeRating,
    User,
    Workstation,
)


def serialize(row: Session, *, only_user: UUID | None = None) -> schemas.Session:
    participants = [
        schemas.Participant(
            user_id=item.user_id,
            workstation_number=item.workstation_id,
            dds_service_id=item.dds_service_id,
            level=item.level,
        )
        for item in row.participants
        if only_user is None or item.user_id == only_user
    ]
    return schemas.Session(
        id=row.id,
        title=row.title,
        teacher_id=row.teacher_id,
        status=cast(Any, row.status),
        participants=participants,
        settings_snapshot=schemas.Settings.model_validate(row.settings_snapshot),
        kind=cast(Any, row.kind),
        started_at=row.started_at,
        finished_at=row.finished_at,
    )


def serialize_assignment(row: Assignment, user_id: UUID) -> schemas.Assignment:
    if row.planned_at is None:
        raise RuntimeError("У назначения отсутствует planned_at.")
    return schemas.Assignment(
        id=row.id,
        session_id=row.session_id,
        participant_id=user_id,
        scenario_id=row.scenario_id,
        order=row.order,
        planned_at=row.planned_at,
        status=cast(Any, row.status),
    )


def ensure_owner(row: Session, user: User) -> None:
    if user.role == "teacher" and row.teacher_id != user.id:
        raise HTTPException(404, "Занятие не найдено.")


async def list_sessions(request: Request) -> list[schemas.Session]:
    rows = await repo.sessions(request.state.db, request.state.user.id, request.state.user.role)
    own = request.state.user.id if request.state.user.role == "trainee" else None
    return [serialize(row, only_user=own) for row in rows]


async def get_session(request: Request, session_id: UUID) -> schemas.Session:
    row = await repo.get_session(request.state.db, session_id)
    if row is None:
        raise HTTPException(404, "Занятие не найдено.")
    ensure_owner(row, request.state.user)
    if request.state.user.role == "trainee" and not any(
        item.user_id == request.state.user.id for item in row.participants
    ):
        raise HTTPException(404, "Занятие не найдено.")
    own = request.state.user.id if request.state.user.role == "trainee" else None
    return serialize(row, only_user=own)


def timing_snapshot(body: schemas.SessionInput) -> dict[str, Any] | None:
    """Снимок методики времени нового занятия (C-02, I-TIME v3).

    Без поля — v3 с нормативами из settings_snapshot; явный null — legacy v1 по
    выбору преподавателя. Переданная политика обязана совпадать с нормативами снимка:
    иначе отчёт и таймер показывали бы разные пороги одной попытки.
    """
    settings = body.settings_snapshot
    if "timing_policy" not in body.model_fields_set:
        return {
            **DEFAULT_TIMING_POLICY,
            "reaction_normative_s": settings.reaction_normative_s,
            "handling_normative_s": settings.handling_normative_s,
        }
    if body.timing_policy is None:
        return None
    policy = dict(body.timing_policy.root)
    if (
        policy["reaction_normative_s"] != settings.reaction_normative_s
        or policy["handling_normative_s"] != settings.handling_normative_s
    ):
        raise HTTPException(
            422,
            {
                "code": "timing_policy_mismatch",
                "message": "Нормативы методики времени должны совпадать с настройками занятия.",
                "details": {},
            },
        )
    return policy


async def create_session(request: Request, body: schemas.SessionInput) -> schemas.Session:
    request.state.entity = "session"
    if not body.participants:
        raise HTTPException(422, "Добавьте хотя бы одного участника.")
    user_ids = [item.user_id for item in body.participants]
    stations = [item.workstation_number for item in body.participants]
    if len(set(user_ids)) != len(user_ids) or len(set(stations)) != len(stations):
        raise HTTPException(409, "Участники и рабочие места в занятии не должны повторяться.")
    users = {
        row.id: row
        for row in (await request.state.db.scalars(select(User).where(User.id.in_(user_ids)))).all()
    }
    services = set(
        (
            await request.state.db.scalars(
                select(Service.id).where(
                    Service.id.in_([item.dds_service_id for item in body.participants]),
                    Service.is_active.is_(True),
                )
            )
        ).all()
    )
    workstations = set(
        (
            await request.state.db.scalars(
                select(Workstation.id).where(Workstation.id.in_(stations))
            )
        ).all()
    )
    if len(users) != len(user_ids) or any(
        user.role != "trainee" or not user.is_active for user in users.values()
    ):
        raise HTTPException(422, "Участник должен быть активным обучаемым.")
    if services != {item.dds_service_id for item in body.participants}:
        raise HTTPException(422, "Неизвестная или неактивная служба участника.")
    if workstations != set(stations):
        raise HTTPException(422, "Неизвестное рабочее место.")
    ratings = {
        row.user_id: row.theta
        for row in (
            await request.state.db.scalars(
                select(TraineeRating).where(TraineeRating.user_id.in_(user_ids))
            )
        ).all()
    }
    row = Session(
        teacher_id=request.state.user.id,
        title=body.title,
        status="draft",
        started_at=None,
        finished_at=None,
        settings_snapshot=body.settings_snapshot.model_dump(),
        timing_policy=timing_snapshot(body),
    )
    request.state.db.add(row)
    await request.state.db.flush()
    for item in body.participants:
        request.state.db.add(
            Participant(
                session_id=row.id,
                user_id=item.user_id,
                workstation_id=item.workstation_number,
                dds_service_id=item.dds_service_id,
                level=item.level,
                rating_at_start=ratings.get(item.user_id, 0.0),
            )
        )
    await request.state.db.flush()
    await request.state.db.refresh(row, attribute_names=["participants"])
    result = serialize(row)
    request.state.entity_id = str(row.id)
    request.state.audit_after = result.model_dump(mode="json")
    return result


async def start_session(request: Request, session_id: UUID) -> schemas.Session:
    request.state.entity = "session"
    request.state.entity_id = str(session_id)
    row = await repo.get_session(request.state.db, session_id, lock=True)
    if row is None:
        raise HTTPException(404, "Занятие не найдено.")
    ensure_owner(row, request.state.user)
    try:
        schemas.Settings.model_validate(row.settings_snapshot)
    except ValidationError as exc:
        raise HTTPException(
            422, "Настройки занятия непригодны для оценки. Создайте новое занятие."
        ) from exc
    assignments = list(
        (
            await request.state.db.scalars(
                select(Assignment)
                .where(Assignment.session_id == row.id)
                .order_by(Assignment.id)
                .with_for_update()
            )
        ).all()
    )
    scenarios = {
        scenario.id: scenario
        for scenario in (
            await request.state.db.scalars(
                select(Scenario)
                .where(Scenario.id.in_([a.scenario_id for a in assignments]))
                .order_by(Scenario.id)
                .with_for_update(read=True)
            )
        ).all()
    }
    for assignment in assignments:
        scenario = scenarios[assignment.scenario_id]
        if scenario.status != "approved":
            raise HTTPException(422, "Запуск требует утверждённых сценариев.")
        if assignment.scenario_version is not None and (
            assignment.scenario_version != scenario.version
        ):
            raise HTTPException(409, "Версия назначенного сценария изменилась.")
        ensure_evaluable(scenario.status, scenario.reference)
    request.state.audit_before = serialize(row).model_dump(mode="json")
    now = datetime.now(UTC)
    if row.status != "draft":
        raise HTTPException(409, "Запустить можно только черновик занятия.")
    count = await request.state.db.scalar(
        select(func.count(func.distinct(Assignment.participant_id))).where(
            Assignment.session_id == row.id
        )
    )
    if not row.participants or count != len(row.participants):
        raise HTTPException(409, "Каждому участнику нужно назначить хотя бы один сценарий.")
    row.status, row.started_at = "running", now
    for assignment in assignments:
        if assignment.delay_from_start_s is not None:
            assignment.due_at = now + timedelta(seconds=assignment.delay_from_start_s)
    event_type = "session.started"
    await request.state.db.flush()
    result = serialize(row)
    request.state.audit_after = result.model_dump(mode="json")
    await notify(request.state.db, event_type, row.id)
    return result


async def list_assignments(request: Request, session_id: UUID) -> list[schemas.Assignment]:
    row = await repo.get_session(request.state.db, session_id)
    if row is None:
        raise HTTPException(404, "Занятие не найдено.")
    ensure_owner(row, request.state.user)
    return [
        serialize_assignment(assignment, user_id)
        for assignment, user_id in await repo.assignments(request.state.db, session_id)
        if assignment.batch_id is None
    ]


async def create_assignment(
    request: Request, session_id: UUID, body: schemas.AssignmentInput
) -> schemas.Assignment:
    request.state.entity = "assignment"
    row = await repo.get_session(request.state.db, session_id, lock=True)
    if row is None:
        raise HTTPException(404, "Занятие не найдено.")
    ensure_owner(row, request.state.user)
    if row.status != "draft":
        raise HTTPException(409, "Назначения можно менять только в черновике занятия.")
    participant = await request.state.db.scalar(
        select(Participant).where(
            Participant.session_id == session_id, Participant.user_id == body.participant_id
        )
    )
    if participant is None:
        raise HTTPException(422, "Участник не входит в занятие.")
    scenario = await request.state.db.scalar(
        select(Scenario).where(Scenario.id == body.scenario_id).with_for_update(key_share=True)
    )
    if scenario is None or scenario.status != "approved":
        raise HTTPException(422, "Назначать можно только утверждённый сценарий.")
    # Проверяем и ранее сохранённые эталоны: старые данные не переписываются.
    ensure_evaluable(scenario.status, scenario.reference)
    duplicate = await request.state.db.scalar(
        select(Assignment.id).where(
            Assignment.session_id == session_id,
            Assignment.participant_id == participant.id,
            Assignment.order == body.order,
        )
    )
    if duplicate is not None:
        raise HTTPException(409, "Порядок назначения для участника уже занят.")
    assignment = Assignment(
        session_id=session_id,
        participant_id=participant.id,
        scenario_id=scenario.id,
        # Версия закрепляется, как в пакетной раздаче: план и эталон карточки не должны
        # зависеть от того, что со сценарием сделают потом (например, архивируют).
        scenario_version=scenario.version,
        order=body.order,
        planned_at=body.planned_at,
        status="pending",
    )
    request.state.db.add(assignment)
    try:
        await request.state.db.flush()
    except IntegrityError as exc:
        raise HTTPException(409, "Назначение конфликтует с существующими данными.") from exc
    result = serialize_assignment(assignment, participant.user_id)
    request.state.entity_id = str(assignment.id)
    request.state.audit_after = result.model_dump(mode="json")
    return result
