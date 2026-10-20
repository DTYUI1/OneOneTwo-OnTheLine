from datetime import UTC, datetime
from uuid import UUID

from evalcore.models import Json
from evalcore.validation import validate_reference
from fastapi import HTTPException, Request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.scenarios import repo, schemas
from app.core.models import Assignment, Scenario, Session
from app.core.training_exercises import is_training_exercise


def serialize(row: Scenario) -> schemas.Scenario:
    values = {
        name: getattr(row, name)
        for name in schemas.Scenario.model_fields
        if name not in {"coherence_unchecked", "variant_label", "is_manual"}
    }
    metadata = row.generation_metadata or {}
    values["is_manual"] = row.origin in {"template", "trainee"} and not metadata
    from app.worker.generators.variant_paths import label

    values["variant_label"] = label(metadata.get("constructor", {}).get("variation"))
    values["coherence_unchecked"] = metadata.get("coherence", {}).get("status") == "unchecked"
    if "coherence" not in metadata and row.origin == "llm":
        values["coherence_unchecked"] = any(
            a.get("accepted")
            and a.get("diagnostics", {}).get("coherence", {}).get("checked") is False
            for a in metadata.get("attempts", [])
        )
    values["created_at"] = row.created_at.isoformat()
    values["id"] = str(row.id)
    return schemas.Scenario.model_validate(values)


async def list_scenarios(db: AsyncSession) -> list[schemas.Scenario]:
    return [
        serialize(row) for row in await repo.list_scenarios(db) if not is_training_exercise(row.id)
    ]


async def playable_scenarios(db: AsyncSession) -> schemas.PlayableScenarios:
    """Утверждённые сценарии, которые закрываются по докладам бригады (эталон, 1.5)."""
    from app.api.training.plan_check import closable

    return schemas.PlayableScenarios(
        scenario_ids=[
            row.id
            for row in await repo.list_scenarios(db)
            if row.status == "approved" and await closable(db, row)
        ]
    )


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
    require_editable(body.id)
    ensure_evaluable(body.status, body.reference)
    request.state.entity = "scenario"
    request.state.entity_id = str(body.id)
    row = Scenario(
        **body.model_dump(
            exclude={"coherence_unchecked", "variant_label", "created_at", "is_manual"}
        ),
        author_id=request.state.user.id,
    )
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
    require_editable(scenario_id)
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
    changes = body.model_dump(
        exclude={"id", "version", "coherence_unchecked", "variant_label", "created_at", "is_manual"}
    )
    if all(getattr(row, name) == value for name, value in changes.items()):
        request.state.audit_after = request.state.audit_before
        return serialize(row)
    for name, value in changes.items():
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
    require_editable(scenario_id)
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
    # Снятый сценарий не выдаётся: его ещё не начатые задания в черновиках занятий отменяются,
    # иначе такое занятие не запустить. Идущие и завершённые занятия — по снимку версии.
    now = datetime.now(UTC)
    for assignment in await request.state.db.scalars(
        select(Assignment)
        .join(Session, Session.id == Assignment.session_id)
        .where(
            Assignment.scenario_id == scenario_id,
            Assignment.cancelled_at.is_(None),
            Session.status == "draft",
        )
        .with_for_update()
    ):
        assignment.cancelled_at = now
        # Legacy Assignment не имеет cancelled; отмена видна в lifecycle.
        if assignment.batch_id is not None:
            assignment.status = "cancelled"
    await flush_scenario(request.state.db)
    result = serialize(row)
    request.state.audit_after = result.model_dump(mode="json")
    return result


def require_editable(scenario_id: UUID) -> None:
    if is_training_exercise(scenario_id):
        raise HTTPException(
            409, "Это служебное упражнение тренажёра: изменять или архивировать его нельзя."
        )
