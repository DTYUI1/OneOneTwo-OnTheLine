from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models import Assignment, Scenario


async def list_scenarios(db: AsyncSession) -> list[Scenario]:
    return list((await db.scalars(select(Scenario).order_by(Scenario.id))).all())


async def get_scenario(
    db: AsyncSession, scenario_id: UUID, *, lock: bool = False
) -> Scenario | None:
    query = select(Scenario).where(Scenario.id == scenario_id)
    if lock:
        # FOR UPDATE конфликтует и с FK-проверкой нового назначения.
        query = query.with_for_update()
    return await db.scalar(query)


async def is_assigned(db: AsyncSession, scenario_id: UUID) -> bool:
    return (
        await db.scalar(select(Assignment.id).where(Assignment.scenario_id == scenario_id).limit(1))
    ) is not None
