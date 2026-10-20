"""Кастинг голосов ElevenLabs для тренажёра ДДС: подобрать, озвучить, послушать, выбрать.

    python3 scripts/voices/casting/casting.py shortlist     # кандидаты из библиотеки (без синтеза)
    python3 scripts/voices/casting/casting.py synth         # смета: сколько символов уйдёт
    python3 scripts/voices/casting/casting.py synth --go    # озвучить то, чего ещё нет
    python3 scripts/voices/casting/casting.py serve         # страница прослушивания

Ключ — ELEVENLABS_API_KEY из окружения или из .env в корне репозитория. Роли и фразы —
roles.json, выбранные кандидаты — cast.json. Каждая запись хранится в out/cache/<sha256>.mp3,
ключ — модель, голос, настройки и текст: одна и та же фраза одним голосом на сервер второй
раз не уходит. out/voices/<роль>/<имя>/ — те же файлы под человеческими именами.
"""

from __future__ import annotations

import hashlib
import http.client
import http.server
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
OUT = HERE / "out"
CACHE = OUT / "cache"
API = os.environ.get("ELEVENLABS_BASE_URL", "https://api.elevenlabs.io")
# Порядок предпочтения: первая модель, которую ключ умеет в text-to-speech и которая знает русский.
MODELS = ("eleven_v4", "eleven_v3", "eleven_multilingual_v2")


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


def call(path: str, body: dict | None = None, raw: bool = False):
    request = urllib.request.Request(
        API + path,
        data=None if body is None else json.dumps(body).encode("utf-8"),
        headers={"xi-api-key": api_key(), "Content-Type": "application/json"},
        method="GET" if body is None else "POST",
    )
    # Обрыв связи посреди ответа: запись уже оплачена, но не дошла — повторить, иначе её не будет.
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                data = response.read()
            break
        except urllib.error.HTTPError as error:
            # 429 — занят лимит одновременных запросов: синтеза не было, подождать и повторить.
            if error.code != 429 or attempt == 2:
                raise
            time.sleep(5 * (attempt + 1))
        except (http.client.IncompleteRead, TimeoutError, ConnectionError, urllib.error.URLError):
            if attempt == 2:
                raise
            print("  обрыв связи, повторяю")
            time.sleep(3 * (attempt + 1))
    return data if raw else json.loads(data)


def load(name: str) -> dict:
    return json.loads((HERE / name).read_text(encoding="utf-8"))


def save(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def credits_left() -> int | str:
    try:
        sub = call("/v1/user/subscription")
    except urllib.error.HTTPError:
        return "не видно (ключу нужно право user_read)"
    return int(sub["character_limit"]) - int(sub["character_count"])


def shortlist() -> None:
    """Кандидаты по ролям из библиотеки голосов: только метаданные и бесплатные превью."""
    models = {m["model_id"]: m for m in call("/v1/models")}
    usable = [
        mid
        for mid in MODELS
        if models.get(mid, {}).get("can_do_text_to_speech")
        and any(lang.get("language_id") == "ru" for lang in models[mid].get("languages", []))
    ]
    found: dict[str, list[dict]] = {}
    previews = OUT / "previews"
    previews.mkdir(parents=True, exist_ok=True)
    for role in load("roles.json")["roles"]:
        seen: dict[str, dict] = {}
        for search in role["search"]:
            query = {
                "language": "ru",
                "page_size": 30,
                "sort": "usage_character_count_1y",
                **search,
            }
            for voice in call("/v1/shared-voices?" + urllib.parse.urlencode(query))["voices"]:
                seen.setdefault(voice["voice_id"], voice)
        found[role["key"]] = [
            {
                key: voice.get(key)
                for key in (
                    "voice_id",
                    "public_owner_id",
                    "name",
                    "gender",
                    "age",
                    "accent",
                    "locale",
                    "use_case",
                    "descriptive",
                    "description",
                    "usage_character_count_1y",
                    "cloned_by_count",
                    "preview_url",
                    "verified_languages",
                )
            }
            for voice in seen.values()
        ]
        for voice in found[role["key"]]:
            target = previews / f"{voice['voice_id']}.mp3"
            if voice["preview_url"] and not target.exists():
                with urllib.request.urlopen(voice["preview_url"], timeout=60) as response:
                    target.write_bytes(response.read())
    save(
        OUT / "candidates.json", {"models": usable, "credits_left": credits_left(), "roles": found}
    )
    print(f"модели с русским: {', '.join(usable) or 'нет'}; кредитов осталось: {credits_left()}")
    for key, voices in found.items():
        print(f"\n{key}: {len(voices)} кандидатов")
        for v in voices[:12]:
            print(
                f"  {v['name'][:28]:28} {v['gender']}/{v['age']} {v['accent']} {v['use_case']} "
                f"{v['descriptive']} — {(v['description'] or '')[:70]}"
            )
    print(f"\nПолный список — {OUT / 'candidates.json'}, превью — {previews}")


def phrase_text(phrase: str | dict, gender: str) -> str:
    return phrase if isinstance(phrase, str) else phrase.get(gender, phrase["male"])


def clip_key(cast: dict, voice_id: str, text: str) -> str:
    material = json.dumps(
        [cast["model"], voice_id, cast.get("settings", {}), text], ensure_ascii=False
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def plan() -> tuple[dict, list[dict]]:
    """Все клипы кастинга: роль × кандидат × фраза, с ключом кеша."""
    cast = load("cast.json")
    roles = {role["key"]: role for role in load("roles.json")["roles"]}
    clips = []
    for key, voices in cast["roles"].items():
        for voice in voices:
            for number, phrase in enumerate(roles[key]["phrases"], start=1):
                text = phrase_text(phrase, voice.get("gender", "male"))
                clips.append(
                    {
                        "role": key,
                        "voice": voice,
                        "number": number,
                        "text": text,
                        "file": CACHE / f"{clip_key(cast, voice['voice_id'], text)}.mp3",
                    }
                )
    return cast, clips


def tts(cast: dict, voice: dict, text: str) -> bytes:
    body = {"text": text, "model_id": cast["model"], "language_code": "ru"}
    if cast.get("settings"):
        body["voice_settings"] = cast["settings"]
    added = json.loads((OUT / "added.json").read_text()) if (OUT / "added.json").exists() else {}
    voice_id = added.get(voice["voice_id"], voice["voice_id"])
    try:
        return call(f"/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128", body, raw=True)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        if voice_id in added.values() or "voice" not in detail or not voice.get("public_owner_id"):
            raise SystemExit(f"ElevenLabs {error.code}: {detail}") from error
    # Голос из библиотеки, которого нет в «моих голосах»: добавить один раз и запомнить.
    owner, original = voice["public_owner_id"], voice["voice_id"]
    new = call(f"/v1/voices/add/{owner}/{original}", {"new_name": f"112 {voice['name']}"})
    added[original] = new["voice_id"]
    save(OUT / "added.json", added)
    print(f"  голос «{voice['name']}» добавлен в «Мои голоса»")
    return call(f"/v1/text-to-speech/{new['voice_id']}?output_format=mp3_44100_128", body, raw=True)


def synth(go: bool) -> None:
    cast, clips = plan()
    todo = [clip for clip in clips if not clip["file"].exists()]
    chars = sum(len(clip["text"]) for clip in todo)
    print(
        f"модель {cast['model']}: клипов {len(clips)}, готово {len(clips) - len(todo)}, "
        f"озвучить {len(todo)} — {chars} символов"
    )
    if todo and not go:
        print(f"кредитов осталось: {credits_left()}. Озвучить: synth --go")
        return
    CACHE.mkdir(parents=True, exist_ok=True)
    for clip in todo:
        print(f"  {clip['role']} {clip['voice']['name']}: {clip['text']}")
        clip["file"].write_bytes(tts(cast, clip["voice"], clip["text"]))
    publish(cast, clips)


def publish(cast: dict, clips: list[dict]) -> None:
    """Человеческие имена файлов и manifest.json для страницы прослушивания."""
    roles = {role["key"]: role for role in load("roles.json")["roles"]}
    shutil.rmtree(OUT / "voices", ignore_errors=True)
    manifest = {"model": cast["model"], "roles": []}
    for key, voices in cast["roles"].items():
        role = roles[key]
        entry = {
            "key": key,
            "env": role["env"],
            "title": role["title"],
            "who": role["who"],
            "voices": [],
        }
        for voice in voices:
            named = []
            for clip in clips:
                if clip["role"] != key or clip["voice"] is not voice or not clip["file"].exists():
                    continue
                target = OUT / "voices" / role["title"] / voice["name"] / f"{clip['number']}.mp3"
                target.parent.mkdir(parents=True, exist_ok=True)
                os.link(clip["file"], target)
                named.append({"text": clip["text"], "src": str(target.relative_to(HERE))})
            entry["voices"].append({**voice, "clips": named})
        manifest["roles"].append(entry)
    save(OUT / "manifest.json", manifest)
    print(f"Файлы — {OUT / 'voices'}. Слушать: python3 {Path(__file__).relative_to(ROOT)} serve")


def serve() -> None:
    os.chdir(HERE.parent)
    print("кастинг — http://localhost:8112/casting/, банк фраз — http://localhost:8112/bank/")
    print("остановить — Ctrl+C")
    http.server.ThreadingHTTPServer(
        ("127.0.0.1", 8112), http.server.SimpleHTTPRequestHandler
    ).serve_forever()


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "shortlist":
        shortlist()
    elif command == "synth":
        synth("--go" in sys.argv)
    elif command == "serve":
        serve()
    else:
        sys.exit(__doc__)
