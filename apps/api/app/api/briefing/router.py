from collections.abc import Callable
from typing import Any
from uuid import UUID

from fastapi import Request

from app.api.briefing import schemas, service


async def check_briefing(
    request: Request, id: UUID, body: schemas.BriefingCheckInput
) -> schemas.BriefingCheck:
    return await service.check_briefing(request, id, body)


ENDPOINTS: dict[str, tuple[Callable[..., Any], Any]] = {
    "checkBriefing": (check_briefing, schemas.BriefingCheck),
}
