"""Озвучка докладов бригад в сценариях самостоятельной тренировки (29.09).

Запускается в контейнере — см. practice_generate.sh. Тексты — data/practice/*.json,
голос бригады — голос её службы (brigade_texts.VOICE_OF_SERVICE), как у учебных докладов.
Раскладка файлов совпадает с apps/api/app/seed/practice.py (audio_path): выезд общий для
обоих уровней, остальные этапы — с номером уровня. Готовый файл с тем же текстом не
пересобирается: повторный запуск не меняет SHA-256 уже выданных докладов.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from brigade_texts import PROFILE_TO_PIPER, VOICE_OF_SERVICE
from synth import BASE, VOICES, fetch, sha256, synth_one


def reports(incident: dict) -> list[tuple[str, str, str]]:
    """(служба, путь относительно data/voices, текст) всех докладов происшествия."""
    result = []
    for service, variant in incident["services"].items():
        base = f"practice/{incident['key']}/{service}"
        result.append((service, f"{base}/departure.ogg", variant["departure"]))
        for stage in ("arrival", "works", "completion"):
            result.append((service, f"{base}/{stage}-1.ogg", variant["full"][stage]))
        for stage in ("arrival", "outcome"):
            result.append((service, f"{base}/{stage}-2.ogg", variant["complication"][stage]))
    return result


def main() -> int:
    cache, scenarios, out = (Path(value) for value in sys.argv[1:4])
    manifest_path = out / "practice" / "manifest.json"
    previous = (
        {item["path"]: item for item in json.loads(manifest_path.read_text("utf-8"))["messages"]}
        if manifest_path.exists()
        else {}
    )
    todo = [
        item
        for path in sorted(scenarios.glob("*.json"))
        for item in reports(json.loads(path.read_text(encoding="utf-8")))
    ]
    messages = []
    models: dict[str, tuple[Path, Path]] = {}
    for service, relative, text in todo:
        old = previous.get(relative)
        target = out / relative
        if old and old["text"] == text and target.exists() and sha256(target) == old["sha256"]:
            messages.append(old)
            continue
        name = PROFILE_TO_PIPER[VOICE_OF_SERVICE[service]]
        if name not in models:
            voice = VOICES[name]
            onnx = cache / f"{Path(voice['path']).name}.onnx"
            conf = cache / f"{Path(voice['path']).name}.onnx.json"
            fetch(f"{BASE}/{voice['path']}.onnx", onnx, voice["onnx_md5"])
            fetch(f"{BASE}/{voice['path']}.onnx.json", conf, voice["json_md5"])
            models[name] = (onnx, conf)
        meta = synth_one(*models[name], text, target.with_suffix(".wav"))
        print(f"  {relative}: {meta['duration_ms']} мс")
        messages.append(
            {
                "service_id": service,
                "path": relative,
                "text": text,
                "duration_ms": meta["duration_ms"],
                "sha256": meta["sha256"],
                "media_type": "audio/ogg",
            }
        )
    manifest = {
        "version": 1,
        "note": (
            "Доклады бригад в сценариях самостоятельной тренировки: тексты — data/practice, "
            "озвучка — Piper, голос службы (scripts/voices/practice_generate.sh). "
            "Пути относительно data/voices."
        ),
        "messages": messages,
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"докладов: {len(messages)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
