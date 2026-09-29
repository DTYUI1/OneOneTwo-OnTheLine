from collections.abc import Callable
from typing import Annotated, Any
from uuid import UUID

from fastapi import File, HTTPException, Request, UploadFile

from app.api.c01 import PENDING_EVENTS
from app.api.cards import schemas, service


async def list_cards(request: Request) -> list[schemas.Card]:
    return await service.list_cards(request)


async def get_card(request: Request, id: UUID) -> schemas.Card:
    return await service.get_card(request, id)


async def list_events(request: Request, id: UUID) -> list[schemas.StoredEvent]:
    return await service.list_events(request, id)


async def post_event(request: Request, id: UUID, body: schemas.CardEvent) -> schemas.EventReceipt:
    if body.root["type"] in PENDING_EVENTS and request.state.user.role != "trainee":
        raise HTTPException(403, "Учебное действие выполняет только обучаемый.")
    # Образец часов C-02 указывает только сам обучаемый; проверка — в service.post_event.
    if "clock_sample_id" in body.root and request.state.user.role != "trainee":
        raise HTTPException(403, "Учебное действие выполняет только обучаемый.")
    return await service.post_event(request, id, body)


async def list_calls(request: Request, id: UUID) -> list[schemas.Call]:
    return await service.list_calls(request, id)


async def get_call(request: Request, id: UUID) -> schemas.Call:
    return await service.get_call(request, id)


async def upload_audio(
    request: Request, id: UUID, audio: Annotated[UploadFile, File()]
) -> schemas.Call:
    return await service.upload_audio(request, id, audio)


ENDPOINTS: dict[str, tuple[Callable[..., Any], Any]] = {
    "listCards": (list_cards, list[schemas.Card]),
    "getCard": (get_card, schemas.Card),
    "listEvents": (list_events, list[schemas.StoredEvent]),
    "postEvent": (post_event, schemas.EventReceipt),
    "listCalls": (list_calls, list[schemas.Call]),
    "getCall": (get_call, schemas.Call),
    "uploadAudio": (upload_audio, schemas.Call),
}
