from uuid import UUID

from fastapi import HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.catalog import repo, schemas
from app.core.models import Assignment, Participant, Scenario, Service, Session


async def list_services(db: AsyncSession) -> list[schemas.Service]:
    return [schemas.Service.model_validate(row) for row in await repo.services(db)]


async def list_incident_types(db: AsyncSession) -> list[schemas.IncidentType]:
    return [schemas.IncidentType.model_validate(row) for row in await repo.incident_types(db)]


async def list_packs(db: AsyncSession) -> list[schemas.Pack]:
    return [
        schemas.Pack.model_validate(
            {
                "id": pack.id,
                "title": pack.title,
                "status": pack.status,
                "scenario_ids": scenario_ids,
                "origin": pack.origin,
            }
        )
        for pack, scenario_ids in await repo.packs(db)
    ]


async def running_sessions_with(db: AsyncSession, service_id: str) -> set[UUID]:
    """Идущие занятия, где служба — ДДС участника или адресат выданного сценария."""
    seats = await db.scalars(
        select(Participant.session_id)
        .join(Session, Session.id == Participant.session_id)
        .where(Session.status == "running", Participant.dds_service_id == service_id)
    )
    tasks = await db.scalars(
        select(Assignment.session_id)
        .join(Session, Session.id == Assignment.session_id)
        .join(Scenario, Scenario.id == Assignment.scenario_id)
        .where(
            Session.status == "running",
            Assignment.status != "cancelled",
            Scenario.target_service_id == service_id,
        )
    )
    return set(seats.all()) | set(tasks.all())


async def update_service(
    request: Request, service_id: str, body: schemas.ServiceUpdate
) -> schemas.Service:
    """C-07, NFR-12: включить или выключить службу. Выключенной нельзя позвонить и
    перенаправить карточку, её нет в новых занятиях и пакетах; идущее занятие не ломаем."""
    db: AsyncSession = request.state.db
    request.state.entity, request.state.entity_id = "services", service_id
    row = await db.get(Service, service_id, with_for_update=True)
    if row is None:
        raise HTTPException(404, "Служба не найдена.")
    if row.is_active and not body.is_active:
        busy = await running_sessions_with(db, service_id)
        if busy:
            raise HTTPException(
                409,
                {
                    "code": "service_in_use",
                    "message": f"Служба участвует в идущих занятиях ({len(busy)}): "
                    "выключите её после их завершения.",
                    "details": {"sessions": len(busy)},
                },
            )
    request.state.audit_before = {"is_active": row.is_active}
    row.is_active = body.is_active
    await db.flush()
    request.state.audit_after = {"is_active": row.is_active}
    return schemas.Service.model_validate(row)
