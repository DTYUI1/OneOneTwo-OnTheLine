from collections.abc import Callable
from typing import Annotated, Any
from uuid import UUID

from fastapi import File, Form, Request, UploadFile

from app.api.voice_reply import schemas, service


async def recognize_reply(
    request: Request,
    id: UUID,
    audio: Annotated[UploadFile, File()],
    delivery_id: Annotated[UUID | None, Form()] = None,
) -> schemas.VoiceReply:
    return await service.recognize_reply(request, id, delivery_id, audio)


ENDPOINTS: dict[str, tuple[Callable[..., Any], Any]] = {
    "recognizeReply": (recognize_reply, schemas.VoiceReply),
}
