"""Сборка data/voices/brigade/completion.pending.json из completion-report.json.

Запускать после ``generate.sh --stage completion``:
    python3 scripts/voices/completion_manifest.py

Отдельно от manifest.py: этап completion ещё не подключён к seed (см.
brigade_texts.py), а manifest.json на развёрнутых стендах неизменяем. Когда L-02
подключит этап, записи отсюда переедут в manifest.json тем, кто это делает.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from brigade_texts import COMPLETION_STAGE

ROOT = Path(__file__).resolve().parents[2]
VOICES = ROOT / "data" / "voices"
REPORT = VOICES / "completion-report.json"
PENDING = VOICES / "brigade" / "completion.pending.json"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    report = json.loads(REPORT.read_text(encoding="utf-8"))

    messages = []
    for service in sorted(report):
        item = report[service]
        path = VOICES / item["file"]
        actual = sha256(path)
        if actual != item["sha256"]:
            raise SystemExit(
                f"sha256 не сошёлся у {path}: ждали {item['sha256']}, получили {actual}"
            )
        messages.append(
            {
                "service_id": service,
                "stage": COMPLETION_STAGE,
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
            "Учебный доклад бригады о завершении работ (VO-01, этап completion): текст — "
            "scripts/voices/brigade_texts.py, озвучка — Piper, голос службы. Этап ещё не "
            "подключён к seed — подключает L-02. Пути относительно data/voices."
        ),
        "messages": messages,
    }
    PENDING.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"ожидающие сообщения: {PENDING.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
