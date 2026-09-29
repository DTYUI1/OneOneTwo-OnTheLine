"""Локальный сервер распознавания речи для STT-01: faster-whisper (small, int8, CPU).

Модель уже лежит в образе (RUN на этапе сборки Dockerfile), поэтому здесь только
загрузка из локального каталога и HTTP-обёртка — сети в работе не требуется.
"""

import asyncio
import os
import tempfile
from pathlib import Path
from typing import Annotated, Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from faster_whisper import WhisperModel

MODEL_SIZE = os.environ.get("STT_MODEL", "small")
MODEL_ROOT = os.environ.get("STT_MODEL_ROOT", "/models")
LANGUAGE = os.environ.get("STT_LANGUAGE", "ru")

app = FastAPI()
model = WhisperModel(
    MODEL_SIZE,
    device="cpu",
    compute_type="int8",
    download_root=MODEL_ROOT,
    local_files_only=True,
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


def _transcribe(path: str) -> str:
    segments, _ = model.transcribe(path, language=LANGUAGE, beam_size=1)
    return "".join(segment.text for segment in segments).strip()


@app.post("/transcribe")
async def transcribe(audio: Annotated[UploadFile, File()]) -> dict[str, Any]:
    data = await audio.read()
    if not data:
        raise HTTPException(422, "Аудиофайл пуст.")
    suffix = Path(audio.filename or "audio.wav").suffix or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
        handle.write(data)
        tmp_path = handle.name
    try:
        text = await asyncio.to_thread(_transcribe, tmp_path)
    finally:
        os.remove(tmp_path)
    return {"text": text, "model": MODEL_SIZE}
