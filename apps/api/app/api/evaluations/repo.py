from uuid import UUID

from sqlalchemy import RowMapping, case, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models import (
    Assignment,
    Card,
    Evaluation,
    Job,
    Participant,
    Prediction,
    Session,
    TeacherOverride,
    User,
)


def evaluation_query():
    return (
        select(
            Evaluation,
            Participant.user_id.label("trainee_id"),
            Session.teacher_id,
            Session.settings_snapshot,
        )
        .join(Card, Card.id == Evaluation.card_id)
        .join(Assignment, Assignment.id == Card.assignment_id)
        .join(Participant, Participant.id == Assignment.participant_id)
        .join(Session, Session.id == Assignment.session_id)
    )


def visible(query, user_id: UUID, role: str):
    if role == "trainee":
        return query.where(Participant.user_id == user_id)
    if role == "teacher":
        return query.where(Session.teacher_id == user_id)
    return query


async def evaluations(db: AsyncSession, user_id: UUID, role: str) -> list[RowMapping]:
    query = visible(evaluation_query(), user_id, role).order_by(
        Evaluation.created_at, Evaluation.id
    )
    return list((await db.execute(query)).mappings())


async def evaluation(
    db: AsyncSession,
    evaluation_id: UUID,
    user_id: UUID,
    role: str,
    *,
    lock: bool = False,
) -> RowMapping | None:
    query = visible(evaluation_query().where(Evaluation.id == evaluation_id), user_id, role)
    if lock:
        query = query.with_for_update(of=Evaluation)
    return (await db.execute(query)).mappings().one_or_none()


async def latest_overrides(
    db: AsyncSession, evaluation_ids: list[UUID]
) -> dict[UUID, TeacherOverride]:
    if not evaluation_ids:
        return {}
    rows = list(
        (
            await db.scalars(
                select(TeacherOverride)
                .where(TeacherOverride.evaluation_id.in_(evaluation_ids))
                .order_by(
                    TeacherOverride.evaluation_id,
                    TeacherOverride.created_at.desc(),
                    TeacherOverride.id.desc(),
                )
            )
        ).all()
    )
    result: dict[UUID, TeacherOverride] = {}
    for row in rows:
        result.setdefault(row.evaluation_id, row)
    return result


async def report_session(
    db: AsyncSession, session_id: UUID, user_id: UUID, role: str
) -> Session | None:
    query = select(Session).where(Session.id == session_id)
    if role == "teacher":
        query = query.where(Session.teacher_id == user_id)
    return await db.scalar(query)


async def report_participants(db: AsyncSession, session_id: UUID) -> list[RowMapping]:
    query = (
        select(Participant, User.full_name)
        .join(User, User.id == Participant.user_id)
        .where(Participant.session_id == session_id)
        .order_by(Participant.workstation_id, Participant.id)
    )
    return list((await db.execute(query)).mappings())


async def report_cards(db: AsyncSession, session_id: UUID) -> list[RowMapping]:
    query = (
        select(Card, Assignment.participant_id)
        .join(Assignment, Assignment.id == Card.assignment_id)
        .where(Assignment.session_id == session_id)
        .order_by(Card.appeared_at, Card.id)
    )
    return list((await db.execute(query)).mappings())


async def report_evaluations(db: AsyncSession, session_id: UUID) -> list[RowMapping]:
    query = (
        evaluation_query()
        .where(Assignment.session_id == session_id)
        .order_by(Evaluation.card_id, Evaluation.version.desc(), Evaluation.created_at.desc())
    )
    return list((await db.execute(query)).mappings())


async def report_predictions(db: AsyncSession, session_id: UUID) -> list[Prediction]:
    query = (
        select(Prediction)
        .join(Card, Card.id == Prediction.card_id)
        .join(Assignment, Assignment.id == Card.assignment_id)
        .where(Assignment.session_id == session_id)
        .order_by(Prediction.made_at, Prediction.id)
    )
    return list((await db.scalars(query)).all())


async def ai_checks(db: AsyncSession, evaluation_ids: list[UUID]) -> dict[UUID, tuple[str, int]]:
    """Состояние ИИ-проверки оценок: (queued | running | failed, задач ИИ впереди).

    Очередь — как у worker (`queue.claim`): идущие задачи, затем ждущие, проверки раньше
    генерации, по run_after. Оценка без задачи или с законченной — не в словаре.
    """
    if not evaluation_ids:
        return {}
    wanted = {str(item) for item in evaluation_ids}
    active = list(
        await db.scalars(
            select(Job)
            .where(Job.kind.in_(["evaluate", "generate"]), Job.status.in_(["running", "pending"]))
            .order_by(
                case((Job.status == "running", 0), else_=1),
                case((Job.kind == "generate", 1), else_=0),
                Job.run_after,
                Job.id,
            )
        )
    )
    checks: dict[UUID, tuple[str, int]] = {}
    for ahead, job in enumerate(active):
        target = job.payload.get("evaluation_id") if job.kind == "evaluate" else None
        if target in wanted and UUID(target) not in checks:
            checks[UUID(target)] = (
                "running" if job.status == "running" else "queued",
                0 if job.status == "running" else ahead,
            )
    failed = await db.scalars(
        select(Job.payload["evaluation_id"].astext).where(
            Job.kind == "evaluate",
            Job.status == "failed",
            Job.payload["evaluation_id"].astext.in_(wanted),
        )
    )
    for target in failed:
        checks.setdefault(UUID(target), ("failed", 0))
    return checks
