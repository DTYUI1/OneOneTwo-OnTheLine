"""Пересоздание авторского черновика с атомарной заменой позиции пакета."""

import re
from typing import Any
from uuid import UUID, uuid4

from fastapi import HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.c01 import C01Input
from app.api.packs.schemas import Job as JobView
from app.api.packs.service import serialize
from app.core.ai_resource import lock_scheduling
from app.core.config import Settings
from app.core.models import AuditLog, Job, Scenario, ScenarioPack, ScenarioPackItem
from app.worker.generators.storage import generate_gameplay_one
from app.worker.generators.validation import GenerationRejected
from app.worker.queue import enqueue_job


class CorrectionInput(C01Input):
    contract_name = "ScenarioCorrectionInput"


def allowed(row: Scenario, author_id: UUID, config: Settings) -> bool:
    # Тот же признак реального ИИ, что у подготовки занятия; fallback не исправляет замечание.
    return config.ai_provider == "local" and editable(row, author_id)


def editable(row: Scenario, author_id: UUID) -> bool:
    return bool(
        row.deleted_at is None
        and row.author_id == author_id
        and row.status == "draft"
        and (row.generation_metadata or {}).get("constructor", {}).get("template")
    )


_LEVEL = re.compile(
    r"(?:уров(?:ень|ня|не|ню|нем)\s*(?:сложности\s*)?(?:№\s*)?([1-4])"
    r"|([1-4])(?:[- ]?(?:й|го|ый|ого))?\s*уров)",
    re.IGNORECASE,
)


def check_note_level(note: str, level: int) -> None:
    for match in _LEVEL.finditer(note):
        requested = int(match[1] or match[2])
        if requested != level:
            raise GenerationRejected(
                f"Замечание не меняет уровень сценария (сейчас {level}). "
                f"Сгенерируйте новый пакет с уровнем {requested}."
            )


async def regenerate(request: Request, id: UUID, body: CorrectionInput) -> JobView:
    db = request.state.db
    if request.app.state.config.ai_provider == "local":
        await lock_scheduling(db)
    row = await db.get(Scenario, id, with_for_update=True)
    if row is None:
        raise HTTPException(404, "Сценарий не найден.")
    if row.author_id != request.state.user.id:
        raise HTTPException(403, "Пересоздать сценарий может только его автор.")
    if not allowed(row, request.state.user.id, request.app.state.config):
        raise HTTPException(409, "Пересоздаётся только сгенерированный черновик при включённом ИИ.")
    members = list(
        await db.scalars(select(ScenarioPackItem).where(ScenarioPackItem.scenario_id == id))
    )
    if len(members) != 1:
        raise HTTPException(409, "Нужен черновик в одном авторском пакете.")
    member = members[0]
    pack = await db.get(ScenarioPack, member.pack_id)
    if pack.created_by != row.author_id or pack.status != "draft":
        raise HTTPException(409, "Пакет уже утверждён или принадлежит другому автору.")
    note = body.root["note"].strip()
    try:
        check_note_level(note, row.level)
    except GenerationRejected as exc:
        raise HTTPException(422, str(exc)) from exc
    active = await db.scalar(
        select(Job).where(
            Job.kind == "generate",
            Job.status.in_(["pending", "running"]),
            Job.payload["previous_scenario_id"].astext == str(id),
        )
    )
    if active is not None:
        if active.payload["note"] != note:
            raise HTTPException(409, "Пересоздание этого черновика уже выполняется.")
        return serialize(active)
    constructor = row.generation_metadata["constructor"]
    replacement = uuid4()
    job = await enqueue_job(
        db,
        kind="generate",
        entity_id=replacement,
        payload={
            "pack_id": str(pack.id),
            "previous_scenario_id": str(id),
            "previous_version": row.version,
            "replacement_id": str(replacement),
            "author_id": str(row.author_id),
            "order": member.order,
            "note": note,
            "count": 1,
            "level": constructor["level"],
            "seed": constructor["seed"],
            "service_id": row.generation_metadata["input"].get("service", row.target_service_id),
            "generation_policy": "after_lessons",
        },
    )
    request.state.entity, request.state.entity_id = "scenario", str(id)
    request.state.audit_after = {
        "job_id": str(job.id),
        "teacher_note": note,
        "previous_scenario_id": str(id),
        "replacement_id": str(replacement),
    }
    return serialize(job)


async def apply(db: AsyncSession, llm: Any, payload: dict[str, Any]) -> dict[str, Any]:
    pack = await db.get(ScenarioPack, UUID(payload["pack_id"]), with_for_update=True)
    old = await db.get(Scenario, UUID(payload["previous_scenario_id"]), with_for_update=True)
    replacement_id = UUID(payload["replacement_id"])
    new = await db.get(Scenario, replacement_id)
    if new is not None and old is not None and old.status == "retired":
        return {"scenario_ids": [str(new.id)], "fallback_count": 0, "complete": True}
    if (
        old is None
        or pack is None
        or not editable(old, UUID(payload["author_id"]))
        or old.version != payload["previous_version"]
        or pack.status != "draft"
        or pack.created_by != old.author_id
    ):
        raise GenerationRejected("Исходный черновик или пакет изменён; пересоздание отменено.")
    member = await db.scalar(
        select(ScenarioPackItem)
        .where(
            ScenarioPackItem.pack_id == pack.id,
            ScenarioPackItem.order == payload["order"],
        )
        .with_for_update()
    )
    if member is None or member.scenario_id != old.id:
        raise GenerationRejected("Позиция исходного черновика изменена.")
    check_note_level(payload["note"], old.level)
    new = await generate_gameplay_one(
        db,
        llm,
        scenario_id=replacement_id,
        author_id=UUID(payload["author_id"]),
        service_id=payload["service_id"],
        level=payload["level"],
        seed=payload["seed"],
        auto_admit=False,
        weight=old.weight,
        correction={
            "note": payload["note"],
            "previous_scenario_id": str(old.id),
            "metadata": old.generation_metadata,
        },
    )
    member.scenario_id = new.id
    old.status = "retired"
    old.version += 1
    db.add(
        AuditLog(
            actor_id=old.author_id,
            action="regenerateScenario",
            entity="scenario",
            entity_id=str(new.id),
            before={"scenario_id": str(old.id)},
            after={
                "previous_scenario_id": str(old.id),
                "scenario_id": str(new.id),
                "teacher_note": payload["note"],
                "pack_id": str(pack.id),
                "order": member.order,
            },
        )
    )
    await db.flush()
    return {"scenario_ids": [str(new.id)], "fallback_count": 0, "complete": True}
