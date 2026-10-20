"""Озвучка реплик сценариев ДДС новым набором голосов (GP-15, TC-09). Запуск — scenario_generate.sh.

    python scenario_synth.py <кэш моделей> <todo.json> <data/voices> <набор> <pronunciation.json>

Движок: есть `ELEVENLABS_API_KEY` — ElevenLabs (облако, по ключу из окружения), нет — Vosk TTS
(локально, CPU, без сети после загрузки модели). Сравнение движков и выбор —
docs/voices_tts_comparison.md. Каждая реплика: текст для синтеза (sayable.py: числа словами,
телефоны группами, аббревиатуры по буквам, ударения из data/pronunciation.json) → синтез →
голос «по телефону» (phone.py: 300–3400 Гц, μ-law, подложка улицы или работ) → Ogg/Opus.

Ключ кеша — текст, текст для синтеза и ревизия словаря: готовый файл с тем же ключом и SHA-256
из манифеста набора не пересобирается, повторный запуск не меняет уже выданные доклады.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import urllib.request
import wave
from pathlib import Path

from phone import phone
from sayable import Pronunciation
from synth import sha256

VOSK_TTS_MODEL = "vosk-model-tts-ru-0.9-multi"
# model.onnx из архива alphacephei.com/vosk/models: подменённая модель дала бы другой голос.
VOSK_TTS_SHA256 = "0fa5a36b22a8bf7fe7179a3882c6371d2c01e5317019e717516f892d329c24b9"
# Дикторы модели (config.json, speaker_id_map): female_0..2 → 0..2, male_0..1 → 3..4.
VOSK_VOICE_OF_SERVICE = {
    "101": ("male_0", 3),
    "102": ("male_1", 4),
    "103": ("female_0", 0),
    "104": ("female_2", 2),
    "GKH": ("male_0", 3),
    "MOSLIFT": ("male_1", 4),
}

ELEVENLABS_URL = os.environ.get("ELEVENLABS_BASE_URL", "https://api.elevenlabs.io")
ELEVENLABS_MODEL = os.environ.get("ELEVENLABS_MODEL", "eleven_multilingual_v2")
# Готовые голоса библиотеки ElevenLabs; свой — ELEVENLABS_VOICE_<служба>=<voice_id>.
ELEVENLABS_VOICE_OF_SERVICE = {
    "101": "pNInz6obpgDQGcFmaJgB",  # Adam
    "102": "ErXwobaYiN019PkySvjV",  # Antoni
    "103": "21m00Tcm4TlvDq8mDLCY",  # Rachel
    "104": "EXAVITQu4vr4xnSDxMaL",  # Bella
    "GKH": "VR6AewLTigWG4xSOukaG",  # Arnold
    "MOSLIFT": "ErXwobaYiN019PkySvjV",  # Antoni
}

# Происшествия на улице: там и после прибытия подложка — улица, а не работы в помещении.
OUTDOOR = ("fight-street", "heart-street", "traffic-blocked")


class Vosk:
    def __init__(self, cache: Path) -> None:
        from vosk_tts import Model, Synth  # type: ignore[import-not-found]

        path = cache / "vosk" / VOSK_TTS_MODEL
        model = Model(model_path=str(path)) if path.exists() else Model(model_name=VOSK_TTS_MODEL)
        if sha256(path / "model.onnx") != VOSK_TTS_SHA256:
            raise SystemExit(f"{path}/model.onnx: SHA-256 не совпадает с закреплённым")
        self.synth = Synth(model)

    def voice(self, service: str) -> str:
        return f"vosk-tts {VOSK_TTS_MODEL} {VOSK_VOICE_OF_SERVICE[service][0]}"

    def say(self, service: str, text: str, wav: Path) -> None:
        self.synth.synth(text, str(wav), speaker_id=VOSK_VOICE_OF_SERVICE[service][1])


def accents(text: str) -> str:
    """«+» перед ударной гласной (так ударение понимает Vosk) → знак ударения после неё."""
    return re.sub(r"\+(\w)", "\\1\u0301", text)


class ElevenLabs:
    def __init__(self, key: str) -> None:
        self.key = key

    def voice_id(self, service: str) -> str:
        return os.environ.get(f"ELEVENLABS_VOICE_{service}", ELEVENLABS_VOICE_OF_SERVICE[service])

    def voice(self, service: str) -> str:
        return f"elevenlabs {ELEVENLABS_MODEL} {self.voice_id(service)}"

    def say(self, service: str, text: str, wav: Path) -> None:
        request = urllib.request.Request(
            f"{ELEVENLABS_URL}/v1/text-to-speech/{self.voice_id(service)}?output_format=pcm_22050",
            data=json.dumps({"text": accents(text), "model_id": ELEVENLABS_MODEL}).encode("utf-8"),
            headers={"xi-api-key": self.key, "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=120) as response:
            pcm = response.read()
        with wave.open(str(wav), "wb") as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(22050)
            out.writeframes(pcm)


def bed(path: str) -> str:
    """Подложка бригады: в пути и на улице — улица, на месте в помещении — работы."""
    incident, name = path.split("/")[1], path.rsplit("/", 1)[-1]
    return "street" if name.startswith("departure") or incident in OUTDOOR else "works"


def seed(path: str) -> int:
    return int(hashlib.sha256(path.encode("utf-8")).hexdigest()[:8], 16)


def main() -> int:
    cache, todo_path, out = (Path(value) for value in sys.argv[1:4])
    voice_set = sys.argv[4]
    pronunciation = Pronunciation.load(Path(sys.argv[5]))
    key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    engine = ElevenLabs(key) if key else Vosk(cache)
    print(f"движок: {'ElevenLabs' if key else 'Vosk TTS (локально)'}")

    manifest_path = out / voice_set / "manifest.json"
    previous = (
        {item["path"]: item for item in json.loads(manifest_path.read_text("utf-8"))["messages"]}
        if manifest_path.exists()
        else {}
    )
    messages = []
    for item in json.loads(todo_path.read_text(encoding="utf-8")):
        old = previous.get(item["path"])
        target = out / item["path"]
        spoken = pronunciation.say(item["text"])
        cache_key = (item["text"], spoken, pronunciation.revision)
        if old and (old["text"], old.get("spoken"), old.get("pronunciation")) == cache_key:
            if target.exists() and sha256(target) == old["sha256"]:
                messages.append(old)
                continue
        target.parent.mkdir(parents=True, exist_ok=True)
        raw = target.with_suffix(".raw.wav")
        engine.say(item["service_id"], spoken, raw)
        millis = phone(raw, target, bed(item["path"]), seed(item["path"]))
        raw.unlink()
        print(f"  {item['path']}: {millis} мс")
        messages.append(
            {
                "service_id": item["service_id"],
                "path": item["path"],
                "text": item["text"],
                "spoken": spoken,
                "pronunciation": pronunciation.revision,
                "voice": engine.voice(item["service_id"]),
                "duration_ms": millis,
                "sha256": sha256(target),
                "media_type": "audio/ogg",
            }
        )
    manifest = {
        "version": 1,
        "note": "Реплики сценариев ДДС (data/scenarios), движок и голос — поле voice, "
        "голос по телефону с подложкой (scripts/voices/phone.py), spoken — текст для синтеза, "
        "pronunciation — ревизия data/pronunciation.json (scripts/voices/scenario_generate.sh). "
        "Пути относительно data/voices.",
        "messages": messages,
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"реплик: {len(messages)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
