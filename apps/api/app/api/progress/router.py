from collections.abc import Callable
from typing import Any

from fastapi import Request

from app.api.progress import schemas, service


async def list_progress(request: Request) -> list[schemas.TraineeProgress]:
    return await service.list_progress(request)


ENDPOINTS: dict[str, tuple[Callable[..., Any], Any]] = {
    "listProgress": (list_progress, list[schemas.TraineeProgress]),
}
