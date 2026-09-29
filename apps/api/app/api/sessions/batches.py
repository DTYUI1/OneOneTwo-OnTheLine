"""Пачка и её исходный ответ фиксируются одной транзакцией HTTP middleware."""

import json
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from fastapi import HTTPException, Request
from sqlalchemy import select

from app.api.c01 import C01Input
from app.api.scenarios.service import ensure_evaluable
from app.api.sessions import repo
from app.api.sessions.service import ensure_owner
from app.core.models import Assignment, AssignmentBatch, Scenario


class AssignmentBatchInput(C01Input):
    contract_name = "AssignmentBatchInput"


class BatchReceipt(C01Input):
    contract_name = "AssignmentBatch"


async def create_batch(
    request: Request, session_id: UUID, body: AssignmentBatchInput
) -> BatchReceipt:
    db = request.state.db
    lesson = await repo.get_session(db, session_id, lock=True)
    if lesson is None:
        raise HTTPException(404, "Занятие не найдено.")
    ensure_owner(lesson, request.state.user)
    request_id = UUID(body.root["request_id"])
    canonical = json.dumps(body.root, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    saved = await db.scalar(
        select(AssignmentBatch).where(
            AssignmentBatch.teacher_id == request.state.user.id,
            AssignmentBatch.session_id == session_id,
            AssignmentBatch.request_id == request_id,
        )
    )
    if saved is not None:
        if saved.canonical_request != canonical:
            raise HTTPException(409, "request_id уже использован для другой пачки.")
        return BatchReceipt(saved.receipt)
    if lesson.status != "draft":
        raise HTTPException(409, "Назначения можно менять только в черновике занятия.")
    participants = {p.user_id: p for p in lesson.participants}
    existing = await repo.assignments(db, session_id)
    last_order: dict[UUID, int] = {}
    last_delay: dict[UUID, int] = {}
    for assignment, _ in existing:
        last_order[assignment.participant_id] = assignment.order
        if assignment.delay_from_start_s is not None:
            last_delay[assignment.participant_id] = assignment.delay_from_start_s
    # Один порядок блокировок сценариев у всех пачек исключает взаимное ожидание.
    scenarios = {
        s.id: s
        for s in (
            await db.scalars(
                select(Scenario)
                .where(Scenario.id.in_([UUID(item["scenario_id"]) for item in body.root["items"]]))
                .order_by(Scenario.id)
                .with_for_update(read=True)
            )
        ).all()
    }
    batch_id = uuid4()
    rows = []
    receipts: list[dict[str, Any]] = []
    for item in body.root["items"]:
        participant = participants.get(UUID(item["participant_id"]))
        scenario = scenarios.get(UUID(item["scenario_id"]))
        if participant is None:
            raise HTTPException(422, "Участник не входит в занятие.")
        if scenario is None or scenario.status != "approved":
            raise HTTPException(422, "Назначать можно только утверждённый сценарий.")
        if scenario.version != item["scenario_version"]:
            raise HTTPException(409, "Версия сценария изменилась.")
        ensure_evaluable(scenario.status, scenario.reference)
        if item["delivery_mode"] == "profile" and (
            scenario.target_service_id != participant.dds_service_id
        ):
            raise HTTPException(422, "Служба сценария не соответствует ДДС участника.")
        if item["order"] <= last_order.get(participant.id, 0):
            raise HTTPException(409, "Порядок назначений участника должен возрастать.")
        if item["delay_from_start_s"] < last_delay.get(participant.id, 0):
            raise HTTPException(422, "Задержка назначений участника не должна убывать.")
        last_order[participant.id] = item["order"]
        last_delay[participant.id] = item["delay_from_start_s"]
        assignment = Assignment(
            id=uuid4(),
            session_id=session_id,
            participant_id=participant.id,
            scenario_id=scenario.id,
            scenario_version=scenario.version,
            batch_id=batch_id,
            order=item["order"],
            delay_from_start_s=item["delay_from_start_s"],
            delivery_mode=item["delivery_mode"],
            status="pending",
            planned_at=None,
        )
        rows.append(assignment)
        receipts.append(
            {
                **item,
                "id": str(assignment.id),
                "session_id": str(session_id),
                "due_at": None,
                "status": "pending",
            }
        )
    result = BatchReceipt(
        {
            "request_id": str(request_id),
            "session_id": str(session_id),
            "assignments": receipts,
            "created_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        }
    )
    db.add(
        AssignmentBatch(
            id=batch_id,
            teacher_id=request.state.user.id,
            session_id=session_id,
            request_id=request_id,
            canonical_request=canonical,
            receipt=result.root,
        )
    )
    await db.flush()
    db.add_all(rows)
    await db.flush()
    request.state.entity = "assignment_batch"
    request.state.entity_id = str(batch_id)
    request.state.audit_after = result.root
    return result


async def list_batches(request: Request, session_id: UUID) -> list[BatchReceipt]:
    lesson = await repo.get_session(request.state.db, session_id)
    if lesson is None:
        raise HTTPException(404, "Занятие не найдено.")
    ensure_owner(lesson, request.state.user)
    rows = await request.state.db.scalars(
        select(AssignmentBatch)
        .where(
            AssignmentBatch.session_id == session_id,
        )
        .order_by(AssignmentBatch.created_at, AssignmentBatch.id)
    )
    return [BatchReceipt(row.receipt) for row in rows]
