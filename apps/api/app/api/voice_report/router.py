from collections.abc import Callable
from typing import Annotated, Any
from uuid import UUID

from fastapi import File, Form, Request, UploadFile

from app.api.voice_report import schemas, service


async def recognize_report(
    request: Request,
    id: UUID,
    audio: Annotated[UploadFile | None, File()] = None,
    text: Annotated[str | None, Form(max_length=1000)] = None,
    earlier: Annotated[str | None, Form(max_length=4000)] = None,
) -> schemas.VoiceReport:
    return await service.recognize_report(request, id, audio, text, earlier)


ENDPOINTS: dict[str, tuple[Callable[..., Any], Any]] = {
    "recognizeReport": (recognize_report, schemas.VoiceReport),
}
