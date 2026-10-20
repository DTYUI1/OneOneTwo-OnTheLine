"""Локальный сервер распознавания речи для STT-01: faster-whisper (small, int8, CPU).

Модель уже лежит в образе (RUN на этапе сборки Dockerfile), поэтому здесь только
загрузка из локального каталога и HTTP-обёртка — сети в работе не требуется.
"""

import asyncio
import math
import os
import tempfile
from pathlib import Path
from typing import Annotated, Any

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio

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


SAMPLE_RATE = 16000
# Кадр 30 мс; речью считаются кадры громче −50 дБ полной шкалы, остальное — паузы и фон.
FRAME = SAMPLE_RATE * 30 // 1000
SPEECH_FLOOR_DB = -50.0
# Перегруз: отсчёт у края шкалы — микрофон захлёбывается от крика или близости.
CLIP_LEVEL = 0.98


def loudness(samples: np.ndarray) -> dict[str, float] | None:
    """Громкость речи во фразе: уровень речевых кадров в дБ полной шкалы и доля перегруза.

    None — речи громче порога нет. Меряется тот же звук, что распознаётся; браузер пишет
    фразу без автоусиления (phraseRecorder), иначе тихое и громкое выровнялись бы.
    """
    usable = len(samples) // FRAME * FRAME
    if usable == 0:
        return None
    frames = samples[:usable].reshape(-1, FRAME)
    rms = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1))
    speech = rms[rms > 10 ** (SPEECH_FLOOR_DB / 20)]
    if speech.size == 0:
        return None
    level = 20 * math.log10(float(np.sqrt(np.mean(speech**2))))
    clipped = float(np.mean(np.abs(samples) >= CLIP_LEVEL))
    return {"speech_dbfs": round(level, 1), "clipped_share": round(clipped, 4)}


def _transcribe(
    path: str, hotwords: str | None = None
) -> tuple[str, float, dict[str, float] | None]:
    """Текст и уверенность 0…1: средняя по длительности вероятность токена сегментов.

    exp(avg_logprob) — та же величина, по которой faster-whisper сам отбрасывает сегменты
    (log_prob_threshold=-1.0 ≈ 0,37). Нет сегментов — уверенность 0: речи не услышано.
    `hotwords` — ожидаемые слова (улица, повод): Whisper охотнее пишет их, а не созвучные.
    """
    samples = decode_audio(path, sampling_rate=SAMPLE_RATE)
    segments, _ = model.transcribe(
        samples, language=LANGUAGE, beam_size=1, hotwords=hotwords or None
    )
    texts: list[str] = []
    weighted = 0.0
    duration = 0.0
    for segment in segments:
        texts.append(segment.text)
        length = max(segment.end - segment.start, 0.01)
        weighted += math.exp(segment.avg_logprob) * (1 - segment.no_speech_prob) * length
        duration += length
    confidence = weighted / duration if duration else 0.0
    return (
        "".join(texts).strip(),
        round(min(max(confidence, 0.0), 1.0), 3),
        loudness(samples),
    )


@app.post("/transcribe")
async def transcribe(
    audio: Annotated[UploadFile, File()],
    hotwords: Annotated[str | None, Form()] = None,
) -> dict[str, Any]:
    data = await audio.read()
    if not data:
        raise HTTPException(422, "Аудиофайл пуст.")
    suffix = Path(audio.filename or "audio.wav").suffix or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
        handle.write(data)
        tmp_path = handle.name
    try:
        text, confidence, level = await asyncio.to_thread(_transcribe, tmp_path, hotwords)
    finally:
        os.remove(tmp_path)
    return {"text": text, "confidence": confidence, "loudness": level, "model": MODEL_SIZE}
