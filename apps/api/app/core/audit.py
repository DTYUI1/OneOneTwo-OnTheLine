"""Мутация и её аудит фиксируются вместе; отказ сохраняется без тела запроса."""

import logging
from collections.abc import Awaitable, Callable

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError

from app.core.models import AuditLog

logger = logging.getLogger(__name__)
# POST без изменений в системе: проверка текста идёт на каждую паузу в наборе — журнал
# засорился бы, а записывать в нём нечего.
READ_ONLY_OPERATIONS = frozenset({"checkSpelling"})


async def transaction_middleware(
    request: Request,
    call_next: Callable[[Request], Awaitable[Response]],
) -> Response:
    async with request.app.state.database.sessions() as db:
        request.state.db = db
        try:
            response = await call_next(request)
            if response.status_code >= 400:
                await db.rollback()
            route = request.scope.get("route")
            if (
                request.method not in {"GET", "HEAD", "OPTIONS"}
                and getattr(route, "operation_id", None) not in READ_ONLY_OPERATIONS
            ):
                # Путь запроса и тело могут содержать ПДн; сохраняем имя операции и ID.
                db.add(
                    AuditLog(
                        actor_id=getattr(request.state, "actor_id", None),
                        action=getattr(route, "operation_id", None) or "unknown",
                        entity=getattr(request.state, "entity", "http"),
                        entity_id=getattr(request.state, "entity_id", None),
                        before=getattr(request.state, "audit_before", None)
                        if response.status_code < 400
                        else None,
                        after=getattr(
                            request.state, "audit_after", {"status_code": response.status_code}
                        )
                        if response.status_code < 400
                        else {"status_code": response.status_code},
                        ip=request.client.host if request.client else None,
                    )
                )
            await db.commit()
            return response
        except (SQLAlchemyError, OSError, TimeoutError):
            await db.rollback()
            logger.error("Транзакция API не выполнена: хранилище недоступно.")
            return JSONResponse(
                {
                    "code": "database_unavailable",
                    "message": "Хранилище временно недоступно.",
                    "details": {},
                },
                status_code=503,
            )
