"""Голоса сценариев ДДС (GP-15): каждая реплика каждого сценария озвучена новым набором.

Набор — data/voices/<первая папка пути>/manifest.json (scripts/voices/bank/port.py);
seed берёт озвучку, только если текст и SHA-256 совпадают с манифестом, иначе реплика
уходит текстом — здесь это ловится заранее.
"""

import hashlib
import importlib.util
import json
import re
import sys
from functools import cache

from app.core.config import ROOT
from app.seed.scenarios import SCENARIOS_DIR

VOICES = ROOT / "data" / "voices"
# Нормализатор текста для синтеза (scripts/voices/sayable.py) — тот же, что у озвучки.
_spec = importlib.util.spec_from_file_location("sayable", ROOT / "scripts/voices/sayable.py")
assert _spec and _spec.loader
sayable = sys.modules.setdefault("sayable", importlib.util.module_from_spec(_spec))
_spec.loader.exec_module(sayable)


@cache
def voice_manifest(folder: str) -> dict[str, dict]:
    return {
        item["path"]: item
        for item in json.loads((VOICES / folder / "manifest.json").read_text("utf-8"))["messages"]
    }


def replies(node):
    if isinstance(node, dict):
        for field, value in node.items():
            if field in ("line", "with") and value:
                yield value
            elif isinstance(value, (dict, list)):
                yield from replies(value)
    elif isinstance(node, list):
        for value in node:
            yield from replies(value)


def test_every_scenario_reply_has_new_voice():
    pronunciation = sayable.Pronunciation.load(ROOT / "data" / "pronunciation.json")
    checked = 0
    for path in sorted(SCENARIOS_DIR.glob("*.json")):
        data = json.loads(path.read_text("utf-8"))
        for line in replies({"plan": data["plan"], "events": data.get("events", [])}):
            # Ожидающих синтеза фраз нет (HQ-055: записаны в bank-v9) — озвучена каждая.
            assert isinstance(line, dict) and line.get("audio"), (path.name, line)
            audio = line["audio"]
            folder = audio.split("/", 1)[0]
            # GP-28: сценарии используют записи банка; несколько выпусков банка живут
            # вместе, а манифест каждой записи остаётся источником текста и SHA-256.
            assert re.fullmatch(r"bank-v\d+", folder), (path.name, audio)
            item = voice_manifest(folder)[audio]
            assert item["text"] == line["text"], audio
            # У синтезированных фраз дополнительно проверяем словарь; записи банка
            # произношение подтверждают самим текстом и неизменным хешем аудио.
            if "spoken" in item:
                assert item["spoken"] == pronunciation.say(line["text"]), audio
                assert item["pronunciation"] == pronunciation.revision, audio
            assert item["voice"].split()[0] == "elevenlabs", audio
            digest = hashlib.sha256((VOICES / audio).read_bytes()).hexdigest()
            assert digest == item["sha256"], audio
            checked += 1
    assert checked > 100
