"""Реплики должностных лиц служб «по телефону» (TC-09): «Слушаю вас» и «Я вас понял…».

    python3 scripts/voices/officials_phone.py   # нужен ffmpeg

Берёт готовые файлы голосов из data/voices/manifest.json (Piper, generate.sh) и пропускает
через телефон с подложкой тихого офиса (phone.py) → data/voices/phone/<голос>/<фраза>.ogg и
data/voices/phone/manifest.json. Исходные файлы и VoiceManifest не меняются: на развёрнутых
стендах их sha256 сверяется. Затем пересобирает карту ассетов софтфона (voiceAssets.ts) —
в бандл едут телефонные версии; manifest.py делает то же через `bundled`.

Готовый файл с тем же исходником и SHA-256 из манифеста не пересобирается.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from phone import phone

ROOT = Path(__file__).resolve().parents[2]
VOICES = ROOT / "data" / "voices"
PHONE = VOICES / "phone"
MANIFEST = PHONE / "manifest.json"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load() -> dict[str, dict[str, Any]]:
    """Исходный путь VoiceManifest → запись телефонной версии."""
    if not MANIFEST.exists():
        return {}
    return {item["source"]: item for item in json.loads(MANIFEST.read_text("utf-8"))["messages"]}


def bundled(profiles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Профили VoiceManifest с телефонными версиями файлов, где они есть."""
    known = load()
    return [
        {
            **profile,
            "files": [
                {**item, **{k: known[item["path"]][k] for k in ("path", "sha256", "duration_ms")}}
                if item["path"] in known
                else item
                for item in profile["files"]
            ],
        }
        for profile in profiles
    ]


def build() -> None:
    known = load()
    profiles = json.loads((VOICES / "manifest.json").read_text("utf-8"))["profiles"]
    messages = []
    for profile in profiles:
        for item in profile["files"]:
            source = ROOT / "data" / item["path"]
            relative = "voices/phone/" + item["path"].split("/", 1)[1]
            target = ROOT / "data" / relative
            old = known.get(item["path"])
            if (
                old
                and old["source_sha256"] == item["sha256"]
                and target.exists()
                and sha256(target) == old["sha256"]
            ):
                messages.append(old)
                continue
            seed = int(hashlib.sha256(relative.encode("utf-8")).hexdigest()[:8], 16)
            millis = phone(source, target, "office", seed)
            print(f"  {relative}: {millis} мс")
            messages.append(
                {
                    "source": item["path"],
                    "source_sha256": item["sha256"],
                    "path": relative,
                    "sha256": sha256(target),
                    "duration_ms": millis,
                }
            )
    manifest = {
        "version": 1,
        "note": "Реплики должностных лиц служб по телефону с подложкой тихого офиса "
        "(scripts/voices/officials_phone.py). source — исходный файл VoiceManifest; "
        "пути относительно data/.",
        "messages": messages,
    }
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", "utf-8")


def main() -> int:
    from manifest import PROFILES, write_assets

    build()
    report = json.loads((VOICES / "synth-report.json").read_text(encoding="utf-8"))
    profiles = json.loads((VOICES / "manifest.json").read_text("utf-8"))["profiles"]
    write_assets(
        bundled(profiles),
        {
            profile_id: {phrase_id: item["text"] for phrase_id, item in report[voice].items()}
            for profile_id, voice in PROFILES.items()
        },
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
