"""C-05: предпросмотр сценария, прогресс генерации, утверждение пакета, происхождение.

Предпросмотр строит детерминированный `evalcore.scenario` по классификатору 046_24 из
`data/classifier.json`: один seed — одни факты и эталон. Утверждение пакета увеличивает
версию каждого сценария, как PUT, и повторяется по request_id без двойного эффекта.
Происхождение выводится из origin; для заданий по билетам — точная ссылка на билет из
`data/ticket_scenarios/manifest.json` и SHA-256 PDF заказчика, без выдуманных данных.
"""

import hashlib
import json
from functools import lru_cache
from typing import Any
from uuid import UUID

from evalcore.scenario import ScenarioBuildError, ScenarioGenerator  # type: ignore[import-untyped]
from fastapi import HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.c01 import C01Input
from app.api.packs.service import serialize as serialize_job
from app.api.scenarios.service import ensure_evaluable
from app.core.config import ROOT
from app.core.models import (
    Job,
    OperationReceipt,
    Scenario,
    ScenarioPack,
    ScenarioPackItem,
    ScenarioTrainingPlan,
)


class ScenarioPreviewInput(C01Input):
    contract_name = "ScenarioPreviewInput"


class ScenarioPreviewView(C01Input):
    contract_name = "ScenarioPreview"


class JobProgressView(C01Input):
    contract_name = "JobProgress"


class PackApprovalInput(C01Input):
    contract_name = "PackApprovalInput"


class PackApprovalView(C01Input):
    contract_name = "PackApproval"


class ScenarioContentView(C01Input):
    contract_name = "ScenarioContent"


@lru_cache
def classifier() -> dict[str, Any]:
    return json.loads((ROOT / "data/classifier.json").read_text(encoding="utf-8"))


@lru_cache
def ticket_manifest() -> dict[str, dict[str, Any]]:
    path = ROOT / "data/ticket_scenarios/manifest.json"
    if not path.is_file():
        return {}
    return {item["scenario_id"]: item for item in json.loads(path.read_text(encoding="utf-8"))}


@lru_cache
def file_sha256(relative: str) -> str | None:
    path = ROOT / relative
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


async def preview(request: Request, body: ScenarioPreviewInput) -> ScenarioPreviewView:
    try:
        result = ScenarioGenerator(classifier())(body.root["constructor"])
    except ScenarioBuildError as exc:
        raise HTTPException(
            422, {"code": exc.code, "message": exc.message, "details": {"path": exc.path}}
        ) from exc
    return ScenarioPreviewView(result)


async def own_pack(db: AsyncSession, pack_id: UUID, user_id: UUID) -> ScenarioPack:
    """Пакет преподавателя или общий засеянный пакет (created_by = NULL)."""
    pack = await db.get(ScenarioPack, pack_id)
    if pack is None or (pack.created_by is not None and pack.created_by != user_id):
        raise HTTPException(404, "Пакет не найден.")
    return pack


async def pack_scenarios(db: AsyncSession, pack_id: UUID) -> list[Scenario]:
    return list(
        (
            await db.scalars(
                select(Scenario)
                .join(ScenarioPackItem, ScenarioPackItem.scenario_id == Scenario.id)
                .where(ScenarioPackItem.pack_id == pack_id)
                .order_by(ScenarioPackItem.order)
            )
        ).all()
    )


async def job_progress(request: Request, job_id: UUID) -> JobProgressView:
    db: AsyncSession = request.state.db
    job = await db.get(Job, job_id)
    pack_id = (job.payload or {}).get("pack_id") if job is not None else None
    if job is None or job.kind != "generate" or pack_id is None:
        raise HTTPException(404, "Задание генерации не найдено.")
    await own_pack(db, UUID(pack_id), request.state.user.id)
    scenarios = await pack_scenarios(db, UUID(pack_id))
    total = max(int(job.payload.get("count", len(scenarios)) or 1), 1)
    warnings = []
    if scenarios and all(item.origin == "template" for item in scenarios):
        warnings.append("ИИ выключен: сценарии собраны детерминированно из шаблона.")
    return JobProgressView(
        {
            "job": serialize_job(job).model_dump(mode="json"),
            "completed": min(len(scenarios), total),
            "total": total,
            "scenario_ids": [str(item.id) for item in scenarios],
            "pack_id": pack_id,
            "warnings": warnings,
        }
    )


async def approve_pack(
    request: Request, pack_id: UUID, body: PackApprovalInput
) -> PackApprovalView:
    db: AsyncSession = request.state.db
    user = request.state.user.id
    value = body.root
    request_id = UUID(value["request_id"])
    request.state.entity, request.state.entity_id = "scenario_pack", str(pack_id)
    await db.execute(
        select(func.pg_advisory_xact_lock(func.hashtextextended(f"approve:{request_id}", 0)))
    )
    await own_pack(db, pack_id, user)
    receipt = await db.get(OperationReceipt, (user, "approvePack", request_id))
    signed = {"pack_id": str(pack_id), **value}
    if receipt is not None:
        if receipt.body != signed:
            raise HTTPException(409, "request_id уже использован для другого утверждения.")
        return PackApprovalView(receipt.response)
    members = {item.id: item for item in await pack_scenarios(db, pack_id)}
    approved = []
    for item in value["scenarios"]:
        row = members.get(UUID(item["scenario_id"]))
        if row is None:
            raise HTTPException(404, "Сценарий не входит в пакет.")
        await db.refresh(row, with_for_update=True)
        if row.version != item["version"]:
            raise HTTPException(409, "Сценарий уже изменён. Загрузите актуальную версию.")
        if row.status != "draft":
            raise HTTPException(409, "Утверждается только черновик.")
        ensure_evaluable("approved", row.reference)
        row.status = "approved"
        row.version += 1
        approved.append({"scenario_id": str(row.id), "version": row.version})
    await db.flush()
    remaining = [str(item.id) for item in members.values() if item.status == "draft"]
    response = {"pack_id": str(pack_id), "approved": approved, "remaining_draft_ids": remaining}
    db.add(
        OperationReceipt(
            actor_id=user,
            operation="approvePack",
            request_id=request_id,
            body=signed,
            response=response,
        )
    )
    request.state.audit_after = response
    return PackApprovalView(response)


def provenance(row: Scenario) -> dict[str, Any]:
    ticket = ticket_manifest().get(str(row.id))
    if ticket is not None:
        return {
            "author_kind": "system",
            "author_id": None,
            "source_kind": "imported",
            "source_id": f"{ticket['source']}#билет {ticket['ticket']}, задача {ticket['task']}",
            "source_version": f"classifier {ticket['classifier_version']}",
            "sha256": file_sha256(ticket["source"]),
            "synthetic": False,
        }
    if row.origin == "trainee":
        kind, source = "trainee", "manual"
    elif row.origin in ("llm", "imported"):
        kind, source = "system", row.origin
    else:
        kind, source = ("teacher", "manual") if row.author_id else ("system", "template")
    return {
        "author_kind": kind,
        "author_id": str(row.author_id) if row.author_id and kind != "system" else None,
        "source_kind": source,
        "source_id": None,
        "source_version": None,
        "sha256": None,
        # Материалы заказчика известны только по манифесту; остальное — учебная синтетика.
        "synthetic": source != "imported",
    }


async def scenario_content(request: Request, scenario_id: UUID) -> ScenarioContentView:
    db: AsyncSession = request.state.db
    row = await db.get(Scenario, scenario_id)
    if row is None:
        raise HTTPException(404, "Сценарий не найден.")
    plan = await db.get(ScenarioTrainingPlan, (row.id, row.version))
    return ScenarioContentView(
        {
            "scenario_id": str(row.id),
            "version": row.version,
            "provenance": provenance(row),
            "training_plan": plan.plan if plan is not None else None,
        }
    )
