from uuid import UUID

from sqlalchemy import RowMapping, String, cast, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models import IncidentType, Job, Scenario, ScenarioPack, ScenarioPackItem, Service


async def services(db: AsyncSession) -> list[Service]:
    return list((await db.scalars(select(Service).order_by(Service.code))).all())


async def incident_types(db: AsyncSession) -> list[RowMapping]:
    # Полный classifier.raw нужен загрузчику и маршрутизации, но отсутствует в HTTP-контракте.
    result = await db.execute(
        select(
            IncidentType.code,
            IncidentType.name,
            IncidentType.group_name,
            IncidentType.main_service_code,
        ).order_by(IncidentType.code)
    )
    return list(result.mappings())


async def packs(db: AsyncSession) -> list[tuple[ScenarioPack, list[UUID]]]:
    # Один запрос даёт согласованный снимок, не теряет пустые пакеты и не создаёт N+1.
    # Отменённая генерация без единого результата — служебная заготовка.
    # Не удаляем её: job и история остановки продолжают ссылаться на пакет.
    empty_cancelled = (
        select(Job.id)
        .where(
            Job.kind == "generate",
            Job.status == "cancelled",
            Job.payload["pack_id"].astext == cast(ScenarioPack.id, String),
        )
        .correlate(ScenarioPack)
        .exists()
    ) & ~(
        select(ScenarioPackItem.scenario_id)
        .where(ScenarioPackItem.pack_id == ScenarioPack.id)
        .correlate(ScenarioPack)
        .exists()
    )
    rows = await db.execute(
        select(ScenarioPack, ScenarioPackItem.scenario_id)
        .outerjoin(
            ScenarioPackItem,
            (ScenarioPackItem.pack_id == ScenarioPack.id)
            & ScenarioPackItem.scenario_id.in_(
                select(Scenario.id).where(Scenario.deleted_at.is_(None))
            ),
        )
        .where(~empty_cancelled)
        .order_by(ScenarioPack.id, ScenarioPackItem.order)
    )
    grouped: dict[UUID, tuple[ScenarioPack, list[UUID]]] = {}
    for pack, scenario_id in rows:
        if pack.id not in grouped:
            grouped[pack.id] = (pack, [])
        if scenario_id is not None:
            grouped[pack.id][1].append(scenario_id)
    return list(grouped.values())
