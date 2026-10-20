"""Сборка звука прототипа ДДС: audio.js с репликами как data URI.

Прототип открывается двойным щелчком по index.html, без сервера, поэтому звук лежит
в audio.js внутри страницы. Новые реплики (`synth` в lines.json) озвучиваются Piper
голосом службы и пропускаются через полосу рации 300–3400 Гц; готовые файлы
тренажёра (`reuse`) копируются как есть.

Запуск без Docker (нужны piper-tts, soundfile, numpy; модели — scripts/voices/.cache):

    python docs/dds_training_review/prototype/voice/build_audio.py
"""

from __future__ import annotations

import base64
import io
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from piper import PiperVoice, SynthesisConfig

HERE = Path(__file__).resolve().parent
PROTOTYPE = HERE.parent
REPO = PROTOTYPE.parents[2]
CACHE = REPO / "scripts" / "voices" / ".cache"
OUT_RATE = 16000  # Opus принимает 8/12/16/24/48 кГц; для рации хватает 16

STYLES = {
    "calm": SynthesisConfig(length_scale=1.0, noise_scale=0.667, noise_w_scale=0.8),
    # Срочное сообщение: быстрее и живее, как у бойца на месте.
    "urgent": SynthesisConfig(length_scale=0.86, noise_scale=0.8, noise_w_scale=1.0, volume=1.2),
}


def radio(audio: np.ndarray, rate: int) -> np.ndarray:
    """Полоса рации, лёгкая перегрузка и тихий шум эфира в начале и в конце."""
    spectrum = np.fft.rfft(audio)
    freqs = np.fft.rfftfreq(audio.size, 1 / rate)
    # Плавные края полосы: без звона на резком срезе.
    low = np.clip((freqs - 250) / 100, 0, 1)
    high = np.clip((3500 - freqs) / 200, 0, 1)
    band = np.fft.irfft(spectrum * low * high, n=audio.size)
    band = np.tanh(band * 2.2) / np.tanh(2.2)
    rng = np.random.default_rng(112)
    hiss = rng.normal(0, 0.012, int(rate * 0.18))
    tail = rng.normal(0, 0.012, int(rate * 0.12))
    return np.concatenate([hiss, band * 0.9, tail])


def resample(audio: np.ndarray, rate: int, target: int) -> np.ndarray:
    if rate == target:
        return audio
    duration = audio.size / rate
    old = np.linspace(0, duration, audio.size, endpoint=False)
    new = np.linspace(0, duration, int(duration * target), endpoint=False)
    return np.interp(new, old, audio)


def synth(voice: PiperVoice, text: str, style: str) -> tuple[bytes, int]:
    chunks = list(voice.synthesize(text, syn_config=STYLES[style]))
    rate = chunks[0].sample_rate
    audio = np.concatenate([chunk.audio_float_array for chunk in chunks]).astype(np.float64)
    audio = resample(radio(audio, rate), rate, OUT_RATE)
    buffer = io.BytesIO()
    sf.write(buffer, audio.astype(np.float32), OUT_RATE, format="OGG", subtype="OPUS")
    return buffer.getvalue(), round(audio.size / OUT_RATE * 1000)


def duration_ms(data: bytes) -> int:
    info = sf.info(io.BytesIO(data))
    return round(info.frames / info.samplerate * 1000)


def main() -> int:
    lines = json.loads((HERE / "lines.json").read_text(encoding="utf-8"))
    voices: dict[str, PiperVoice] = {}
    sounds: dict[str, str] = {}
    lengths: dict[str, int] = {}
    for item in lines["synth"]:
        name = item["voice"]
        if name not in voices:
            voices[name] = PiperVoice.load(CACHE / f"ru_RU-{name}-medium.onnx")
        data, length = synth(voices[name], item["text"], item.get("style", "calm"))
        sounds[item["id"]] = base64.b64encode(data).decode("ascii")
        lengths[item["id"]] = length
        print(f"  synth {item['id']}: {length} мс, {len(data)} байт")
    for item in lines["reuse"]:
        data = (REPO / item["path"]).read_bytes()
        sounds[item["id"]] = base64.b64encode(data).decode("ascii")
        lengths[item["id"]] = duration_ms(data)
        print(f"  reuse {item['id']}: {lengths[item['id']]} мс")
    body = ",\n".join(
        f'  "{key}": "data:audio/ogg;base64,{value}"' for key, value in sounds.items()
    )
    (PROTOTYPE / "audio.js").write_text(
        "// Сгенерировано voice/build_audio.py — не править руками.\n"
        f"window.PROTO_AUDIO = {{\n{body}\n}};\n"
        f"window.PROTO_AUDIO_MS = {json.dumps(lengths, ensure_ascii=False)};\n",
        encoding="utf-8",
    )
    print(f"audio.js: {len(sounds)} реплик")
    return 0


if __name__ == "__main__":
    sys.exit(main())
