from uuid import UUID

from evalcore.models import Json
from evalcore.validation import validate_reference
from fastapi import HTTPException, Request
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.scenarios import repo, schemas
from app.core.models import Scenario


def serialize(row: Scenario) -> schemas.Scenario:
    values = {name: getattr(row, name) for name in schemas.Scenario.model_fields}
    values["id"] = str(row.id)
    return schemas.Scenario.model_validate(values)


async def list_scenarios(db: AsyncSession) -> list[schemas.Scenario]:
    return [serialize(row) for row in await repo.list_scenarios(db)]


async def get_scenario(db: AsyncSession, scenario_id: UUID) -> schemas.Scenario:
    row = await repo.get_scenario(db, scenario_id)
    if row is None:
        raise HTTPException(404, "Сценарий не найден.")
    return serialize(row)


async def flush_scenario(db: AsyncSession) -> None:
    try:
        await db.flush()
    except IntegrityError as exc:
        # SQLSTATE одинаков для asyncpg-обёртки; текст БД с телом карточки не выдаём.
        code = getattr(exc.orig, "sqlstate", None)
        if code == "23505":
            raise HTTPException(409, "Сценарий с таким ID уже существует.") from exc
        if code == "23503":
            raise HTTPException(422, "Неизвестный тип происшествия или служба.") from exc
        raise


async def create_scenario(request: Request, body: schemas.Scenario) -> schemas.Scenario:
    ensure_evaluable(body.status, body.reference)
    request.state.entity = "scenario"
    request.state.entity_id = str(body.id)
    row = Scenario(**body.model_dump(), author_id=request.state.user.id)
    request.state.db.add(row)
    await flush_scenario(request.state.db)
    result = serialize(row)
    request.state.audit_after = result.model_dump(mode="json")
    return result


async def update_scenario(
    request: Request, scenario_id: UUID, body: schemas.Scenario
) -> schemas.Scenario:
    request.state.entity = "scenario"
    request.state.entity_id = str(scenario_id)
    if body.id != scenario_id:
        raise HTTPException(422, "ID в пути и теле запроса должны совпадать.")
    row = await repo.get_scenario(request.state.db, scenario_id, lock=True)
    if row is None:
        raise HTTPException(404, "Сценарий не найден.")
    if body.version != row.version:
        raise HTTPException(409, "Сценарий уже изменён. Загрузите актуальную версию.")
    if await repo.is_assigned(request.state.db, scenario_id):
        raise HTTPException(409, "Назначенный сценарий нельзя изменить. Создайте копию.")
    ensure_evaluable(body.status, body.reference)
    request.state.audit_before = serialize(row).model_dump(mode="json")
    for name, value in body.model_dump(exclude={"id", "version"}).items():
        setattr(row, name, value)
    row.version += 1
    await flush_scenario(request.state.db)
    result = serialize(row)
    request.state.audit_after = result.model_dump(mode="json")
    return result


def ensure_evaluable(status: str, reference: dict[str, Json]) -> None:
    """Черновики и история читаются; непригодный эталон нельзя утвердить."""
    if status == "approved":
        try:
            validate_reference(reference)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc


async def retire_scenario(request: Request, scenario_id: UUID) -> schemas.Scenario:
    """Архивировать сценарий, не меняя содержимое, на которое ссылаются занятия."""
    request.state.entity = "scenario"
    request.state.entity_id = str(scenario_id)
    row = await repo.get_scenario(request.state.db, scenario_id, lock=True)
    if row is None:
        raise HTTPException(404, "Сценарий не найден.")
    if row.status == "retired":
        raise HTTPException(409, "Сценарий уже архивирован.")
    request.state.audit_before = serialize(row).model_dump(mode="json")
    row.status = "retired"
    row.version += 1
    await flush_scenario(request.state.db)
    result = serialize(row)
    request.state.audit_after = result.model_dump(mode="json")
    return result
