from uuid import UUID, uuid4

from fastapi import HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.packs import schemas
from app.core.models import Job, ScenarioPack, Service
from app.worker.queue import enqueue_job


def serialize(row: Job) -> schemas.Job:
    return schemas.Job.model_validate(row)


async def generate_pack(request: Request, body: schemas.GenerateInput) -> schemas.Job:
    request.state.entity = "job"
    service = await request.state.db.get(Service, body.service_id)
    if service is None or not service.is_active:
        raise HTTPException(422, "Неизвестная или неактивная служба.")
    pack_id = uuid4()
    request.state.db.add(
        ScenarioPack(
            id=pack_id,
            title=f"Сгенерированный пакет (seed {body.seed})",
            status="draft",
            origin="template" if request.app.state.config.ai_provider == "off" else "llm",
            created_by=request.state.user.id,
        )
    )
    row = await enqueue_job(
        request.state.db,
        kind="generate",
        payload={
            "pack_id": str(pack_id),
            **body.model_dump(exclude={"options"}),
        },
        entity_id=pack_id,
        version=1,
    )
    await request.state.db.flush()
    request.state.entity_id = str(row.id)
    result = serialize(row)
    request.state.audit_after = result.model_dump(mode="json")
    return result


async def get_job(db: AsyncSession, job_id: UUID) -> schemas.Job:
    row = await db.scalar(select(Job).where(Job.id == job_id))
    if row is None:
        raise HTTPException(404, "Задание не найдено.")
    return serialize(row)
