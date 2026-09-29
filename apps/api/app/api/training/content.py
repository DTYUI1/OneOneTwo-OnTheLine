"""Версионное хранение и выбор учебного плана; редактор подключается в C-05."""

from typing import Any
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.contracts import validate_json
from app.core.models import (
    Assignment,
    Brigade,
    CallTarget,
    MessageAudioAsset,
    Scenario,
    ScenarioTrainingPlan,
    User,
)


async def plan_for_assignment(
    db: AsyncSession, assignment: Assignment, scenario: Scenario
) -> ScenarioTrainingPlan | None:
    """План не новее версии назначения; архивирование не лишает карточку докладов.

    До 28.09 одиночная раздача не сохраняла версию сценария. Архивирование повышает
    её без нового плана, поэтому берём последнюю существующую версию не позднее
    закреплённой (либо текущей для старого назначения без версии).
    """
    version = (
        assignment.scenario_version if assignment.scenario_version is not None else scenario.version
    )
    return await db.scalar(
        select(ScenarioTrainingPlan)
        .where(
            ScenarioTrainingPlan.scenario_id == scenario.id,
            ScenarioTrainingPlan.scenario_version <= version,
        )
        .order_by(ScenarioTrainingPlan.scenario_version.desc())
        .limit(1)
    )


async def store_plan(
    db: AsyncSession,
    scenario_id: UUID,
    scenario_version: int,
    author_id: UUID,
    plan: dict[str, Any],
) -> ScenarioTrainingPlan:
    """Вызывается импортом/будущим редактором в его транзакции, без переписывания истории."""
    validate_json(plan, "urn:openapi#/components/schemas/TrainingPlan")
    author = await db.get(User, author_id)
    if author is None or author.role != "teacher" or not author.is_active:
        raise HTTPException(403, "План задаёт активный преподаватель.")
    scenario = await db.scalar(select(Scenario).where(Scenario.id == scenario_id).with_for_update())
    if scenario is None or scenario.author_id not in {None, author_id}:
        raise HTTPException(404, "Сценарий не найден.")
    if scenario.version != scenario_version:
        raise HTTPException(409, "Версия сценария изменилась.")
    existing = await db.get(ScenarioTrainingPlan, (scenario_id, scenario_version))
    if existing is not None:
        if existing.author_id == author_id and existing.plan == plan:
            return existing
        raise HTTPException(409, "План этой версии уже сохранён.")
    if await db.scalar(select(Assignment.id).where(Assignment.scenario_id == scenario_id).limit(1)):
        raise HTTPException(409, "Назначенному сценарию нельзя менять план. Создайте новую версию.")
    brigade_ids = {UUID(b) for b in plan["required_brigade_ids"]}
    brigade_ids.update(UUID(m["brigade_id"]) for m in plan["messages"])
    brigades = {
        b.id: b
        for b in (
            await db.scalars(
                select(Brigade)
                .where(Brigade.id.in_(brigade_ids))
                .order_by(Brigade.id)
                .with_for_update(read=True)
            )
        ).all()
    }
    if len(brigades) != len(brigade_ids) or any(
        not b.is_active or b.service_id != scenario.target_service_id for b in brigades.values()
    ):
        raise HTTPException(422, "Бригады плана должны принадлежать службе сценария.")
    messages = set()
    for planned in plan["messages"]:
        message = planned["message"]
        if message["id"] in messages:
            raise HTTPException(422, "Сообщение плана не должно повторяться.")
        messages.add(message["id"])
        target = await db.get(CallTarget, UUID(planned["call_target_id"]))
        if (
            target is None
            or not target.is_active
            or (
                target.brigade_id != UUID(planned["brigade_id"])
                or target.service_id != brigades[UUID(planned["brigade_id"])].service_id
            )
        ):
            raise HTTPException(422, "Адресат плана не соответствует бригаде.")
        audio = message["audio"]
        if audio is not None:
            asset = await db.get(MessageAudioAsset, (UUID(audio["asset_id"]), audio["version"]))
            if (
                asset is None
                or asset.sha256 != audio["sha256"]
                or (asset.duration_ms != audio["duration_ms"])
            ):
                raise HTTPException(422, "Версия аудио не зарегистрирована или изменилась.")
    for defect in plan["observable_defects"]:
        if (defect["evidence_source"] == "card" and defect["message_id"] is not None) or (
            defect["evidence_source"] == "message" and defect["message_id"] not in messages
        ):
            raise HTTPException(422, "У дефекта отсутствует источник наблюдаемых сведений.")
    row = ScenarioTrainingPlan(
        scenario_id=scenario_id, scenario_version=scenario_version, author_id=author_id, plan=plan
    )
    db.add(row)
    await db.flush()
    return row
