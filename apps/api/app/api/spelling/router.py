from collections.abc import Callable
from typing import Any

from fastapi import Request

from app.api.spelling import schemas, service


async def check_spelling(request: Request, body: schemas.SpellingInput) -> schemas.SpellingCheck:
    return await service.check_spelling(request, body)


ENDPOINTS: dict[str, tuple[Callable[..., Any], Any]] = {
    "checkSpelling": (check_spelling, schemas.SpellingCheck),
}
