"""Сборка data/voices/manifest.json из отчёта синтеза.

Запускать после generate.sh:  python3 scripts/voices/manifest.py

Манифест пишется строго по contracts/storage.schema.json#/$defs/VoiceManifest —
там additionalProperties: false, поэтому происхождение и лицензии живут не здесь,
а в scripts/voices/PROVENANCE.md. Единственное решение этого файла — какой голос
стоит за каким профилем; оно вынесено в PROFILES, чтобы менять его одной строкой.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VOICES = ROOT / "data" / "voices"

# Профиль -> голос Piper. Лицензии голосов различаются, см. PROVENANCE.md:
# denis и dmitri — CC0, irina — Unknown, ruslan — CC BY-NC-SA 4.0.
PROFILES = {
    "voice-1": "denis",
    "voice-2": "irina",
    "voice-3": "dmitri",
    "voice-4": "ruslan",
}

# Тексты обязательных фраз во всех родах (scripts/voices/synth.py, PHRASES_BY_GENDER).
PHRASES = [
    "Слушаю вас",
    "Я вас понял, информация принята",
    "Я вас поняла, информация принята",
]


# Фронтенд берёт реплики из бандла: эндпоинта для них в контракте нет, а
# выдумывать свой API задание запрещает.
#
# Файлы кладутся рядом с кодом, а не импортируются из data/: образ web собирается
# из контекста, где есть только apps/web и contracts (apps/web/Dockerfile), и
# импорт за пределы apps/web в контейнере не резолвится. Канонический экземпляр
# остаётся в data/voices — оттуда его читает backend. Копию можно будет удалить,
# если капитан добавит в Dockerfile строку `COPY data/voices data/voices`.
SOFTPHONE = ROOT / "apps" / "web" / "src" / "arm" / "softphone"
ASSETS = SOFTPHONE / "voiceAssets.ts"
BUNDLED = SOFTPHONE / "voices"
# Сообщения бригад в VoiceManifest не помещаются: там phrase_id ограничен
# listen/accepted и additionalProperties: false. По контракту они приходят как
# InformationMessage.audio из C-04: seed `app.seed.training` регистрирует файлы
# по этому манифесту (SHA-256 и длительность сверяются при регистрации).
BRIGADE_MANIFEST = VOICES / "brigade" / "manifest.json"
STAGE_ORDER = ("departure", "arrival", "works")


def write_brigade(report: dict) -> None:
    messages = []
    for service in sorted(report):
        for stage in STAGE_ORDER:
            item = report[service][stage]
            messages.append(
                {
                    "service_id": service,
                    "stage": stage,
                    # Путь относительно data/voices — каталога information_audio_dir.
                    "path": item["file"],
                    "text": item["text"],
                    "duration_ms": item["duration_ms"],
                    "sha256": item["sha256"],
                    "media_type": "audio/ogg",
                }
            )
    manifest = {
        "version": 1,
        "note": (
            "Учебные доклады бригад (выезд, прибытие, работы): тексты — "
            "scripts/voices/brigade_texts.py, озвучка — Piper, голос службы. "
            "Пути относительно data/voices."
        ),
        "messages": messages,
    }
    BRIGADE_MANIFEST.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"сообщения бригад: {BRIGADE_MANIFEST.relative_to(ROOT)}")


def write_assets(profiles: list[dict], texts: dict[str, dict[str, str]]) -> None:
    if BUNDLED.exists():
        shutil.rmtree(BUNDLED)
    lines = [
        "// Сгенерировано scripts/voices/manifest.py — руками не править.",
        "// Реплики едут в бандле: своего эндпоинта для них в контракте нет.",
        "",
        'import type { Phrase } from "./voices";',
        "",
    ]
    imports, entries = [], []
    for profile in profiles:
        rows = []
        for item in profile["files"]:
            name = f"{profile['id'].replace('-', '_')}_{item['phrase_id']}"
            source = ROOT / "data" / item["path"]
            target = BUNDLED / Path(item["path"]).relative_to("voices")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            rel = "./voices/" + target.relative_to(BUNDLED).as_posix()
            imports.append(f'import {name} from "{rel}?url";')
            duration = item["duration_ms"]
            text = json.dumps(texts[profile["id"]][item["phrase_id"]], ensure_ascii=False)
            rows.append(
                f"    {item['phrase_id']}: {{ url: {name}, durationMs: {duration}, text: {text} }},"
            )
        entries.append(f'  "{profile["id"]}": {{\n' + "\n".join(rows) + "\n  },")

    lines += imports + [
        "",
        "export interface VoiceAsset {",
        "  readonly url: string;",
        "  readonly durationMs: number;",
        "  /** Что звучит в файле дословно — в роде голоса («понял» / «поняла»). */",
        "  readonly text: string;",
        "}",
        "",
        "export const VOICE_ASSETS: Record<string, Record<Phrase, VoiceAsset>> = {",
        *entries,
        "};",
        "",
    ]
    ASSETS.write_text("\n".join(lines), encoding="utf-8")
    print(f"карта ассетов: {ASSETS.relative_to(ROOT)}")


def main() -> int:
    report = json.loads((VOICES / "synth-report.json").read_text(encoding="utf-8"))

    profiles = []
    for profile_id, voice in PROFILES.items():
        files = [
            {
                "phrase_id": phrase_id,
                # Путь относительно data/, как его читает PrerenderedTTS.
                "path": f"voices/{item['file']}",
                "sha256": item["sha256"],
                "duration_ms": item["duration_ms"],
            }
            for phrase_id, item in sorted(report[voice].items())
        ]
        missing = [f for f in files if not (ROOT / "data" / f["path"]).is_file()]
        if missing:
            raise SystemExit(f"нет файлов для {profile_id}: {missing}")
        profiles.append({"id": profile_id, "files": files, "status": "ready"})

    manifest = {
        "version": 2,
        "status": "ready",
        "phrases": PHRASES,
        "profiles": profiles,
    }
    (VOICES / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    write_assets(
        profiles,
        {
            profile_id: {phrase_id: item["text"] for phrase_id, item in report[voice].items()}
            for profile_id, voice in PROFILES.items()
        },
    )
    brigade = json.loads((VOICES / "brigade-report.json").read_text(encoding="utf-8"))
    write_brigade(brigade)
    print(f"манифест собран: {len(profiles)} профиля, статус ready")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
