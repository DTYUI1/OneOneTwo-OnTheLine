"""Проверка гарнитуры — contracts/headset-check.md (TC-14).

Фраза обучаемого без звонка: распознаётся тем же провайдером, что и доклад голосом, и
нигде не сохраняется. Операция вне openapi.json (как live/router.py).
"""

import logging
import tempfile
from pathlib import Path
from typing import Annotated, cast

from evalcore.loudness import loudness_verdict
from fastapi import APIRouter, Depends, File, Request, UploadFile
from pydantic import BaseModel

from app.api.foundation.router import require_roles
from app.api.voice_report.schemas import VoiceReportLoudness
from app.api.voice_report.service import audio_kind, spool_audio, stt_or_503

logger = logging.getLogger(__name__)


class HeadsetCheck(BaseModel):
    text: str
    confidence: float | None
    loudness: VoiceReportLoudness | None


router = APIRouter(prefix="/api", include_in_schema=False)


@router.post(
    "/headset-check",
    operation_id="headset_check",
    dependencies=[Depends(require_roles("trainee"))],
)
async def headset_check(request: Request, audio: Annotated[UploadFile, File()]) -> HeadsetCheck:
    request.state.entity = "headset_check"
    request.state.entity_id = str(request.state.user.id)
    provider = await stt_or_503(request, audio)
    _, extension = await audio_kind(audio)
    with tempfile.NamedTemporaryFile(suffix=extension) as handle:
        await spool_audio(audio, handle)
        recognition = await provider.recognize(Path(handle.name))
    loudness = (
        cast(VoiceReportLoudness, loudness_verdict(*recognition.loudness))
        if recognition.loudness is not None
        else None
    )
    return HeadsetCheck(
        text=recognition.text.strip(), confidence=recognition.confidence, loudness=loudness
    )
