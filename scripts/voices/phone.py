"""Голос «по телефону» (TC-09): полоса 300–3400 Гц, 8 кГц, μ-law и тихая подложка места.

    millis = phone(source, target, bed="street", seed=7)

Цепочка ffmpeg: речь → 8 кГц, полоса телефона, сжатие; 250 мс открытой линии до и после
речи; подложка места под всей репликой (бригада — улица или работы, должностное лицо — тихий
офис), в той же полосе; смесь кодируется μ-law (G.711, как в телефонной сети) и уходит в
Ogg/Opus 20 кбит/с, 16 кГц, как остальные реплики. Подложки тихие: они говорят «где
собеседник», а не нагнетают. Шум с фиксированным `seed` — повторная сборка звучит так же.
"""

from __future__ import annotations

import subprocess
import wave
from pathlib import Path

BAND = "highpass=f=300,lowpass=f=3400"
# Подложки места, 8 кГц; {seed} — зерно шума.
BEDS = {
    # Улица: поток машин волной раз в 7 с.
    "street": (
        "anoisesrc=color=pink:amplitude=0.05:sample_rate=8000:seed={seed},"
        "bandpass=f=500:width_type=h:w=700,tremolo=f=0.14:d=0.5"
    ),
    # Работы: гул помещения и мотор (насос, генератор) на 110 Гц.
    "works": (
        "anoisesrc=color=brown:amplitude=0.05:sample_rate=8000:seed={seed},lowpass=f=700[room];"
        "sine=f=110:sample_rate=8000,volume=0.012,tremolo=f=5:d=0.3[motor];"
        "[room][motor]amix=inputs=2:normalize=0"
    ),
    # Тихий офис: ровный фон помещения, едва слышный.
    "office": ("anoisesrc=color=brown:amplitude=0.015:sample_rate=8000:seed={seed},lowpass=f=1200"),
}
OPUS = ["-ar", "16000", "-ac", "1", "-c:a", "libopus", "-b:a", "20k"]


def graph(bed: str, seed: int) -> str:
    return (
        f"[0:a]aresample=8000,{BAND},"
        "acompressor=threshold=-20dB:ratio=4:attack=5:release=80:makeup=4dB,"
        "adelay=250:all=1,apad=pad_dur=0.25[voice];"
        f"{BEDS[bed].format(seed=seed)},{BAND}[bed];"
        "[voice][bed]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.9[out]"
    )


def ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args], check=True)


def phone(source: Path, target: Path, bed: str, seed: int) -> int:
    """Реплика `source` (любой формат ffmpeg) → `target` (.ogg). Возвращает длительность, мс."""
    mixed = target.with_suffix(".mix.wav")
    mulaw = target.with_suffix(".ulaw.wav")
    target.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg(
        "-i",
        str(source),
        "-filter_complex",
        graph(bed, seed),
        "-map",
        "[out]",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        str(mixed),
    )
    with wave.open(str(mixed), "rb") as handle:
        millis = round(1000 * handle.getnframes() / handle.getframerate())
    ffmpeg("-i", str(mixed), "-ar", "8000", "-c:a", "pcm_mulaw", str(mulaw))
    ffmpeg("-i", str(mulaw), *OPUS, str(target))
    mixed.unlink()
    mulaw.unlink()
    return millis
