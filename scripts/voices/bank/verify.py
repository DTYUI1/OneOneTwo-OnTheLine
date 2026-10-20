"""Проверка записей банка на слух машиной: локальный Whisper распознаёт запись, сверяем с текстом.

    tmp/whisper-venv/bin/python scripts/voices/bank/verify.py

Ловит то, что человек услышит сразу: проглоченное или лишнее слово, тег подачи, прочитанный
вслух, чужой язык. Ударения не ловит. Результат — out/verify.json по SHA-256 записи
(повторный запуск проверяет только новые), подозрительные фразы — в выводе.
"""

from __future__ import annotations

import json
import re
from difflib import SequenceMatcher
from pathlib import Path

from faster_whisper import WhisperModel  # type: ignore[import-not-found]

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
THRESHOLD = 0.85


def plain(text: str) -> str:
    text = re.sub(r"\[[^\]]*\]", " ", text.lower().replace("ё", "е"))
    return " ".join(re.sub(r"[^\w\s]", " ", text).split())


def main() -> None:
    manifest = json.loads((OUT / "manifest.json").read_text(encoding="utf-8"))
    path = OUT / "verify.json"
    done = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    model = WhisperModel("large-v3", device="cpu", compute_type="int8", cpu_threads=8)
    phrases = [p for book in manifest["services"].values() for p in book["phrases"]]
    todo = [p for p in phrases if p["sha256"] not in done]
    for number, phrase in enumerate(todo, start=1):
        segments, _ = model.transcribe(
            str(HERE / phrase["audio"]),
            language="ru",
            beam_size=1,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        heard = " ".join(segment.text.strip() for segment in segments)
        done[phrase["sha256"]] = {
            "id": phrase["id"],
            "heard": heard,
            "match": round(SequenceMatcher(None, plain(phrase["text"]), plain(heard)).ratio(), 3),
        }
        print(f"{number}/{len(todo)} {done[phrase['sha256']]['match']} {phrase['id']}", flush=True)
        path.write_text(json.dumps(done, ensure_ascii=False, indent=1), encoding="utf-8")
    suspicious = [
        (done[p["sha256"]]["match"], p["id"], p["text"], done[p["sha256"]]["heard"])
        for p in phrases
        if done[p["sha256"]]["match"] < THRESHOLD
        or re.search(r"[A-Za-z]", done[p["sha256"]]["heard"])
    ]
    print(f"\nПроверено {len(phrases)}, подозрительных {len(suspicious)}:")
    for match, pid, text, heard in sorted(suspicious):
        print(f"{match}  {pid}\n   текст:    {text}\n   услышано: {heard}")


if __name__ == "__main__":
    main()
