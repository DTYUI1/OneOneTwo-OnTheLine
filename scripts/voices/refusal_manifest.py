"""Сборка карты отказа бригады для софтфона из refusal-report.json (28.09).

Запускать после ``generate.sh --stage refusal``:
    python3 scripts/voices/refusal_manifest.py

Отдельно от manifest.py: отказ — не фраза Q14, в VoiceManifest
(contracts/storage.schema.json, phrase_id только listen/accepted) его нет, а
manifest.py пересобирает каталог voices/ софтфона целиком. Поэтому файлы едут в
свой каталог refusal/ рядом с кодом, а карта — в refusalAssets.ts.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

from brigade_texts import PROFILE_TO_PIPER, REFUSAL_PHRASES

ROOT = Path(__file__).resolve().parents[2]
VOICES = ROOT / "data" / "voices"
REPORT = VOICES / "refusal-report.json"
SOFTPHONE = ROOT / "apps" / "web" / "src" / "arm" / "softphone"
ASSETS = SOFTPHONE / "refusalAssets.ts"
BUNDLED = SOFTPHONE / "refusal"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    report = json.loads(REPORT.read_text(encoding="utf-8"))
    if BUNDLED.exists():
        shutil.rmtree(BUNDLED)

    imports, entries = [], []
    for profile, voice in PROFILE_TO_PIPER.items():
        rows = []
        for refusal_id in REFUSAL_PHRASES:
            item = report[voice][refusal_id]
            source = VOICES / item["file"]
            actual = sha256(source)
            if actual != item["sha256"]:
                raise SystemExit(
                    f"sha256 не сошёлся у {source}: ждали {item['sha256']}, получили {actual}"
                )
            target = BUNDLED / voice / f"{refusal_id}.ogg"
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            name = f"{profile.replace('-', '_')}_{refusal_id}"
            imports.append(f'import {name} from "./refusal/{voice}/{refusal_id}.ogg?url";')
            text = json.dumps(item["text"], ensure_ascii=False)
            rows.append(
                f"    {refusal_id}: {{ url: {name}, durationMs: {item['duration_ms']}, "
                f"text: {text} }},"
            )
        entries.append(f'  "{profile}": {{\n' + "\n".join(rows) + "\n  },")

    lines = [
        "// Сгенерировано scripts/voices/refusal_manifest.py — руками не править.",
        "// Отказ бригады, не направленной на происшествие (28.09): это не фраза Q14, поэтому",
        "// не в VoiceManifest, а отдельной картой. Нет файла — текст с пометкой (voices.ts).",
        "",
        'import type { Refusal } from "./machine";',
        'import type { VoiceAsset } from "./voiceAssets";',
        "",
        *imports,
        "",
        "export const REFUSAL_ASSETS: Record<",
        "  string,",
        "  Partial<Record<Refusal, VoiceAsset>>",
        "> = {",
        *entries,
        "};",
        "",
    ]
    ASSETS.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    print(f"карта отказа: {ASSETS.relative_to(ROOT)}, голосов {len(entries)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
