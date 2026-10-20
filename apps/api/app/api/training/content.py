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


async def check_audio(db: AsyncSession, message: dict[str, Any]) -> None:
    audio = message["audio"]
    if audio is None:
        return
    asset = await db.get(MessageAudioAsset, (UUID(audio["asset_id"]), audio["version"]))
    if (
        asset is None
        or asset.sha256 != audio["sha256"]
        or asset.duration_ms != audio["duration_ms"]
    ):
        raise HTTPException(422, "Версия аудио не зарегистрирована или изменилась.")


def event_lines(events: list[dict[str, Any]], message_ids: set[str]) -> list[dict[str, Any]]:
    """Проверить связи событий плана (DT-10) и вернуть все их реплики.

    Реплики событий выдаются тем же путём, что доклады, и отличаются по id: id реплики не
    совпадает ни с докладом плана, ни с другой репликой. Ссылки триггеров и последствий
    ведут на существующие доклады и события; ответ вариантом — только на реплику с
    вариантами, и нужный вариант среди них.
    """
    event_ids = [event["id"] for event in events]
    if len(set(event_ids)) != len(event_ids):
        raise HTTPException(422, "Событие плана не должно повторяться.")
    lines: list[dict[str, Any]] = []
    for event in events:
        trigger = event["trigger"]
        if "message_id" in trigger and trigger["message_id"] not in message_ids:
            raise HTTPException(422, "Триггер события ссылается на несуществующий доклад.")
        if "event_id" in trigger and (
            trigger["event_id"] not in event_ids or trigger["event_id"] == event["id"]
        ):
            raise HTTPException(422, "Триггер события ссылается на несуществующее событие.")
        keys = {option["key"] for option in event.get("reply_options", [])}
        for expect in event["expect"]:
            if expect["action"] in {"reply", "correct_readback"} and (
                event["line"] is None or expect["option_key"] not in keys
            ):
                raise HTTPException(422, "Ответ бригаде ждут на реплику с этим вариантом.")
        branches = event["branches"].values()
        for branch in branches:
            awaits = branch.get("awaits_call", {})
            relay_id = awaits.get("relay_event")
            if relay_id:
                relay = next((item for item in events if item["id"] == relay_id), None)
                if (
                    relay is None
                    or relay is event
                    or not awaits.get("required_facts")
                    or relay["brigade_id"] != event["brigade_id"]
                    or relay["call_target_id"] != event["call_target_id"]
                ):
                    raise HTTPException(
                        422, "Передача сведений — событие той же бригады этого плана."
                    )
            for effect in branch["effects"]:
                if effect.get("delay", effect.get("replace")) not in message_ids:
                    raise HTTPException(422, "Последствие события — для доклада этого плана.")
                if "with" in effect:
                    lines.append(effect["with"])
        lines += [item for item in [event["line"], *(b["line"] for b in branches)] if item]
    spoken = [line["id"] for line in lines if not _replacement(line, events)]
    if len(set(spoken)) != len(spoken) or set(spoken) & message_ids:
        raise HTTPException(422, "У каждой реплики события свой id, не как у доклада.")
    return lines


def _replacement(line: dict[str, Any], events: list[dict[str, Any]]) -> bool:
    """Подмена доклада выдаётся под id доклада плана — её id не обязан быть уникальным."""
    return any(
        effect.get("with") is line
        for event in events
        for branch in event["branches"].values()
        for effect in branch["effects"]
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
    brigade_ids.update(UUID(e["brigade_id"]) for e in plan.get("events") or [])
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
        await check_audio(db, message)
    events = plan.get("events") or []
    for line in event_lines(events, messages):
        await check_audio(db, line)
    for event in events:
        target = await db.get(CallTarget, UUID(event["call_target_id"]))
        brigade = brigades.get(UUID(event["brigade_id"]))
        if (
            brigade is None
            or target is None
            or not target.is_active
            or target.brigade_id != brigade.id
        ):
            raise HTTPException(422, "Событие должно идти от бригады плана по её номеру.")
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
