import secrets
from typing import Any
from uuid import UUID, uuid4

from fastapi import HTTPException, Request
from sqlalchemy import cast, func, or_, select
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.packs import schemas
from app.core.ai_resource import active_generations, lessons_running, lock_scheduling
from app.core.models import Job, OperationReceipt, ScenarioPack, Service, User
from app.worker.generators.validation import SERVICES
from app.worker.queue import enqueue_job


def serialize(row: Job) -> schemas.Job:
    return schemas.Job.model_validate(row)


async def generate_pack(request: Request, body: schemas.GenerateInput) -> schemas.Job:
    request.state.entity = "job"
    db = request.state.db
    if request.app.state.config.ai_provider == "local":
        await lock_scheduling(db)
    if body.generation_request_id is not None:
        await db.execute(
            select(
                func.pg_advisory_xact_lock(
                    func.hashtextextended(
                        f"generate:{request.state.user.id}:{body.generation_request_id}", 0
                    )
                )
            )
        )
        receipt = await db.get(
            OperationReceipt, (request.state.user.id, "generatePack", body.generation_request_id)
        )
        if receipt is not None:
            if receipt.body != body.model_dump(mode="json", exclude_unset=True):
                raise HTTPException(409, "request_id уже использован для другой генерации.")
            return await get_job(db, UUID(receipt.response["job_id"]))
    service = await request.state.db.get(Service, body.service_id)
    if service is None or not service.is_active or body.service_id not in SERVICES:
        raise HTTPException(422, "Неизвестная, неактивная или неподдерживаемая служба.")
    seed = body.seed if body.seed is not None else secrets.randbelow(1_000_000_000)
    personal = {}
    if body.trainee_login is not None:
        from app.api.analysis.weak_spots import profile
        from app.api.sessions.preparation import recommend_for_user
        from app.worker.generators.personalization import focus_orders

        trainee = await trainee_by_login(db, body.trainee_login)
        recommendation = await recommend_for_user(db, trainee.id, body.service_id)
        weak = await profile(db, trainee.id)
        focused = focus_orders(body.count, seed)
        personal = {
            "trainee_login": trainee.login,
            "items": [
                {
                    "participant_id": str(trainee.id),
                    "service_id": body.service_id,
                    "level": body.level,
                    "weight": recommendation.weight if body.level == recommendation.level else None,
                    "seed": seed + order - 1,
                    "order": order,
                    "weak_spots": weak,
                    "focus": order in focused,
                }
                for order in range(1, body.count + 1)
            ],
        }
    pack_id = uuid4()
    request.state.db.add(
        ScenarioPack(
            id=pack_id,
            title=f"Сгенерированный пакет (исходное число {seed})",
            status="draft",
            origin="template",
            created_by=request.state.user.id,
        )
    )
    row = await enqueue_job(
        request.state.db,
        kind="generate",
        payload={
            "pack_id": str(pack_id),
            "seed": seed,
            **body.model_dump(
                mode="json",
                exclude={"options", "generation_request_id", "seed"},
                exclude_unset=True,
            ),
            **personal,
        },
        entity_id=pack_id,
        version=1,
    )
    await request.state.db.flush()
    if body.generation_request_id is not None:
        db.add(
            OperationReceipt(
                actor_id=request.state.user.id,
                operation="generatePack",
                request_id=body.generation_request_id,
                body=body.model_dump(mode="json", exclude_unset=True),
                response={"job_id": str(row.id)},
            )
        )
    request.state.entity_id = str(row.id)
    result = serialize(row)
    request.state.audit_after = result.model_dump(mode="json")
    return result


async def resource_state(request: Request) -> schemas.AIResourceState:
    local = request.app.state.config.ai_provider == "local"
    return schemas.AIResourceState(
        local_ai=local,
        lesson_running=local and await lessons_running(request.state.db),
        generation_running=local and bool(await active_generations(request.state.db)),
    )


async def generation_jobs(request: Request) -> list[Any]:
    from app.api.content.service import job_progress

    rows = await request.state.db.scalars(
        select(Job)
        .join(
            ScenarioPack,
            ScenarioPack.id == cast(Job.payload["pack_id"].astext, PGUUID),
        )
        .where(
            Job.kind == "generate",
            ScenarioPack.created_by == request.state.user.id,
            Job.payload["session_id"].astext.is_(None),
            Job.payload["previous_scenario_id"].astext.is_(None),
        )
        .order_by(Job.run_after.desc(), Job.id.desc())
        .limit(5)
    )
    return [await job_progress(request, row.id) for row in rows]


async def get_job(db: AsyncSession, job_id: UUID) -> schemas.Job:
    row = await db.scalar(select(Job).where(Job.id == job_id))
    if row is None:
        raise HTTPException(404, "Задание не найдено.")
    return serialize(row)


async def trainee_by_login(db: AsyncSession, login: str) -> User:
    trainee = await db.scalar(
        select(User).where(User.login == login, User.role == "trainee", User.is_active.is_(True))
    )
    if trainee is None:
        raise HTTPException(422, "Активный обучаемый с таким логином не найден.")
    return trainee


async def search_trainees(
    request: Request, login: str, service_id: str | None = None
) -> list[schemas.GenerationTrainee]:
    from app.api.sessions.preparation import recommend_for_user

    db = request.state.db
    if service_id is not None:
        service = await db.get(Service, service_id)
        if service is None or not service.is_active or service_id not in SERVICES:
            raise HTTPException(422, "Неизвестная, неактивная или неподдерживаемая служба.")
    users = await db.scalars(
        select(User)
        .where(
            User.role == "trainee",
            User.is_active.is_(True),
            or_(
                User.login.icontains(login.strip(), autoescape=True),
                User.full_name.icontains(login.strip(), autoescape=True),
            ),
        )
        .order_by((User.login == login.strip()).desc(), User.login)
        .limit(20)
    )
    result = []
    for user in users:
        recommendation = await recommend_for_user(
            db, user.id, service_id if service_id is not None else user.dds_service_id or ""
        )
        result.append(
            schemas.GenerationTrainee(
                id=user.id,
                login=user.login,
                full_name=user.full_name,
                dds_service_id=user.dds_service_id,
                recommended_level=recommendation.level,
                explanation=recommendation.explanation,
            )
        )
    return result
