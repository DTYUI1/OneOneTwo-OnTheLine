"""Копия голосов заявителей «Оператор 112» для веба и карта voiceAssets.ts (этап 2).

Запускать после ``scripts/voices/operator_generate.sh``:
    python3 scripts/voices/operator_manifest.py

Образ web собирается без data/ (apps/web/Dockerfile), поэтому файлы едут копией в
apps/web/src/operator/voices/, как у отказов бригад (refusal_manifest.py).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "data" / "voices" / "operator"
REPORT = SOURCE / "operator-report.json"
MODULE = ROOT / "apps" / "web" / "src" / "operator"
BUNDLED = MODULE / "voices"
ASSETS = MODULE / "voiceAssets.ts"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def copy(item: dict) -> str:
    source = SOURCE / item["file"]
    actual = sha256(source)
    if actual != item["sha256"]:
        raise SystemExit(f"sha256 не сошёлся у {source}: ждали {item['sha256']}, получили {actual}")
    target = BUNDLED / item["file"]
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    return item["file"]


def name_of(path: str) -> str:
    return "v_" + re.sub(r"[^a-z0-9]+", "_", path.removesuffix(".ogg").lower())


def main() -> int:
    report = json.loads(REPORT.read_text(encoding="utf-8"))
    if BUNDLED.exists():
        shutil.rmtree(BUNDLED)
    imports: list[str] = []
    lines: list[str] = []
    for scenario_id, rows in report["lines"].items():
        for line, item in rows.items():
            path = copy(item)
            name = name_of(path)
            imports.append(f'import {name} from "./voices/{path}?url";')
            lines.append(f'  "{scenario_id}/{line}": {name},')
    backgrounds: list[str] = []
    for background, item in report["backgrounds"].items():
        path = copy(item)
        name = name_of(path)
        imports.append(f'import {name} from "./voices/{path}?url";')
        backgrounds.append(f"  {background}: {name},")
    ASSETS.write_text(
        "// Сгенерировано scripts/voices/operator_manifest.py — руками не править.\n"
        "// Голоса заявителей и фон в трубке (этап 2): Piper и ffmpeg, operator_generate.sh.\n"
        "// Нет файла — реплика звучит текстом (voice.ts).\n\n"
        + "\n".join(imports)
        + "\n\n/** «<сценарий>/<реплика>» → файл; ключ приходит от сервера в reply.voice. */\n"
        + "export const CALLER_VOICES: Readonly<Record<string, string>> = {\n"
        + "\n".join(lines)
        + "\n};\n\n/** Фон в трубке по scenario.background. */\n"
        + "export const BACKGROUNDS: Readonly<Record<string, string>> = {\n"
        + "\n".join(backgrounds)
        + "\n};\n",
        encoding="utf-8",
        newline="\n",
    )
    total = sum(path.stat().st_size for path in BUNDLED.rglob("*.ogg"))
    print(f"реплик: {len(lines)}, фонов: {len(backgrounds)}, всего {total} байт")
    print(f"карта: {ASSETS.relative_to(ROOT)}")
    # Карту проверяет `pnpm lint` (prettier): приводим её к стилю веба сразу.
    prettier = ["pnpm", "--dir", "apps/web", "exec", "prettier", "--write", str(ASSETS)]
    try:
        subprocess.run(prettier, cwd=ROOT, check=True, capture_output=True, shell=os.name == "nt")
    except (OSError, subprocess.CalledProcessError):
        print("prettier не запустился — выполните: " + " ".join(prettier))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
