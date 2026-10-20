"""Голос наставника Николая Сергеевича: синтез реплик тренажёра в ElevenLabs.

Реплики — apps/web/src/shared/mascot/voice/lines.json: `text` — как на экране, `speech` — как
произносить, если отличается (галочка вместо ✓, «Альт плюс Зет» вместо Alt+Z). Голос, модель и
формат — из того же файла, как в библии маскота (раздел 4): Alex Bell, eleven_multilingual_v2,
mp3_44100_64. Файл реплики — voice/<id>.mp3; что из чего озвучено — voice/synth.json (хеш
произносимого текста, голоса и модели). Синтезируются только новые и изменённые реплики.

Ключ — ELEVENLABS_API_KEY из окружения или из .env в корне репозитория. Из России ElevenLabs
закрыт: запускать через прокси подходящего узла VPN (HTTPS_PROXY=http://127.0.0.1:<порт>),
urllib берёт его из окружения.

    python scripts/voices/mascot_synth.py          # что будет озвучено и сколько символов
    python scripts/voices/mascot_synth.py --go     # озвучить
    python scripts/voices/mascot_synth.py --probe  # пропускает ли узел (без ключа)
    python scripts/voices/mascot_synth.py --go --redo answer,greet  # новый дубль тех же реплик
"""

from __future__ import annotations

import hashlib
import http.client
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VOICE = ROOT / "apps/web/src/shared/mascot/voice"
LINES = VOICE / "lines.json"
DONE = VOICE / "synth.json"
API = os.environ.get("ELEVENLABS_BASE_URL", "https://api.elevenlabs.io")


def api_key() -> str:
    key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not key and (ROOT / ".env").exists():
        for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
            name, _, value = line.partition("=")
            if name.strip() == "ELEVENLABS_API_KEY":
                key = value.strip().strip("'\"")
    if not key:
        sys.exit("Нет ключа: впишите ELEVENLABS_API_KEY= в .env в корне репозитория.")
    return key


def probe() -> bool:
    """Узел годится, если отвечает сам API (server: uvicorn), а не 302 на страницу ограничений."""

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):  # noqa: ANN002, ANN003
            return None

    opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(API + "/v1/models", timeout=20) as response:
            status, server = response.status, response.headers.get("server", "")
    except urllib.error.HTTPError as error:
        status, server = error.code, error.headers.get("server", "")
    except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
        print(f"нет связи: {error}")
        return False
    ok = status != 302 and "uvicorn" in server.lower()
    print(f"{status} server={server or '—'}: {'годится' if ok else 'блок'}")
    return ok


def tts(voice_id: str, model: str, fmt: str, text: str) -> bytes:
    body = {"text": text, "model_id": model, "language_code": "ru"}
    request = urllib.request.Request(
        f"{API}/v1/text-to-speech/{voice_id}?output_format={fmt}",
        data=json.dumps(body).encode("utf-8"),
        headers={"xi-api-key": api_key(), "Content-Type": "application/json"},
        method="POST",
    )
    # Один голос — один запрос за раз (параллельные дают 409 already_running), поэтому по очереди.
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")
            if error.code not in (409, 429) or attempt == 2:
                raise SystemExit(f"ElevenLabs {error.code}: {detail}") from error
            time.sleep(5 * (attempt + 1))
        except (http.client.IncompleteRead, TimeoutError, ConnectionError, urllib.error.URLError):
            if attempt == 2:
                raise
            print("  обрыв связи, повторяю")
            time.sleep(3 * (attempt + 1))
    raise AssertionError("недостижимо")


def main() -> None:
    if "--probe" in sys.argv:
        sys.exit(0 if probe() else 1)
    go = "--go" in sys.argv
    doc = json.loads(LINES.read_text(encoding="utf-8"))
    voice_id, model, fmt = doc["voice"]["voice_id"], doc["model"], doc["format"]
    done = json.loads(DONE.read_text(encoding="utf-8")) if DONE.exists() else {}
    # --redo id,id — новый дубль, даже если текст не менялся (не понравилась интонация).
    redo = set()
    if "--redo" in sys.argv:
        redo = set(sys.argv[sys.argv.index("--redo") + 1].split(","))
    todo = []
    for line in doc["lines"]:
        speech = line.get("speech", line["text"])
        digest = hashlib.sha256(f"{voice_id}|{model}|{fmt}|{speech}".encode()).hexdigest()
        fresh = done.get(line["id"], {}).get("sha256") == digest
        if fresh and line["id"] not in redo and (VOICE / f"{line['id']}.mp3").exists():
            continue
        todo.append((line["id"], speech, digest))
    known = {line["id"] for line in doc["lines"]}
    for stale in sorted(set(done) - known):
        print(f"лишняя запись: {stale}.mp3 — реплики больше нет в lines.json")
    print(f"к озвучке: {len(todo)} реплик, {sum(len(s) for _, s, _ in todo)} символов")
    for line_id, speech, _ in todo:
        print(f"  {line_id}: {speech}")
    if not go or not todo:
        return
    for line_id, speech, digest in todo:
        audio = tts(voice_id, model, fmt, speech)
        (VOICE / f"{line_id}.mp3").write_bytes(audio)
        done[line_id] = {"sha256": digest, "bytes": len(audio)}
        text = json.dumps(done, ensure_ascii=False, indent=2, sort_keys=True)
        DONE.write_text(text + "\n", encoding="utf-8", newline="\n")
        print(f"  ✓ {line_id}.mp3 ({len(audio) // 1024} КБ)")


if __name__ == "__main__":
    main()
