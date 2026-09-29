from collections.abc import Callable
from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import Query, Request

from app.api.audit import service


async def list_audit(
    request: Request,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: Annotated[str | None, Query(min_length=1, max_length=120)] = None,
    category: Literal["all", "admin", "access", "training", "technical"] = "all",
    result: Literal["all", "ok", "error"] = "all",
    actor_id: UUID | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
) -> service.AuditPageView:
    return await service.list_audit(
        request, limit, cursor, category, result, actor_id, since, until
    )


ENDPOINTS: dict[str, tuple[Callable[..., Any], Any]] = {
    "listAudit": (list_audit, service.AuditPageView),
}
