from collections.abc import Callable
from typing import Any
from uuid import UUID

from fastapi import HTTPException, Request

from app.api.c01 import FinishInput
from app.api.sessions import batches, lifecycle, practice, schemas, service


async def list_sessions(request: Request) -> list[schemas.Session]:
    return await service.list_sessions(request)


async def create_session(request: Request, body: schemas.SessionInput) -> schemas.Session:
    # Снимок timing_policy реализован C-02 в database; mock остаётся spec-first (501).
    if "timing_policy" in body.model_fields_set and request.state.user.role != "teacher":
        raise HTTPException(403, "Недостаточно прав для учебного действия.")
    return await service.create_session(request, body)


async def get_session(request: Request, id: UUID) -> schemas.Session:
    return await service.get_session(request, id)


async def start_session(request: Request, id: UUID) -> schemas.Session:
    return await service.start_session(request, id)


async def finish_session(
    request: Request, id: UUID, body: FinishInput | None = None
) -> schemas.Session:
    # Даже явный JSON null — новый запрос, а не молчаливый вызов старого finish.
    if await request.body():
        if request.state.user.role != "teacher":
            raise HTTPException(403, "Недостаточно прав для учебного действия.")
        if body is None:
            raise HTTPException(422, "Укажите contract_version и request_id.")
        return await lifecycle.finish(request, id, UUID(body.root["request_id"]))
    return await lifecycle.finish(request, id)


async def start_practice(request: Request, step: int | None = None) -> schemas.Session:
    return await practice.start_practice(request, step)


async def create_batch(
    request: Request, id: UUID, body: batches.AssignmentBatchInput
) -> batches.BatchReceipt:
    return await batches.create_batch(request, id, body)


async def list_batches(request: Request, id: UUID) -> list[batches.BatchReceipt]:
    return await batches.list_batches(request, id)


async def get_lifecycle(request: Request, id: UUID) -> lifecycle.SessionLifecycle:
    return await lifecycle.get_lifecycle(request, id)


async def list_assignments(request: Request, id: UUID) -> list[schemas.Assignment]:
    return await service.list_assignments(request, id)


async def create_assignment(
    request: Request, id: UUID, body: schemas.AssignmentInput
) -> schemas.Assignment:
    return await service.create_assignment(request, id, body)


ENDPOINTS: dict[str, tuple[Callable[..., Any], Any]] = {
    "listSessions": (list_sessions, list[schemas.Session]),
    "createSession": (create_session, schemas.Session),
    "getSession": (get_session, schemas.Session),
    "startSession": (start_session, schemas.Session),
    "finishSession": (finish_session, schemas.Session),
    "listAssignments": (list_assignments, list[schemas.Assignment]),
    "createAssignment": (create_assignment, schemas.Assignment),
    "createAssignmentBatch": (create_batch, batches.BatchReceipt),
    "listAssignmentBatches": (list_batches, list[batches.BatchReceipt]),
    "getSessionLifecycle": (get_lifecycle, lifecycle.SessionLifecycle),
    "startPractice": (start_practice, schemas.Session),
}
