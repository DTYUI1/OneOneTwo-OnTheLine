"""Записи банка → набор озвучки стенда: голос по телефону, data/voices/<набор>/ и manifest.json.

    python3 scripts/voices/bank/port.py bank-v1 <корень репозитория с data/voices>

Источник — out/manifest.json (bank.py synth). В набор идут фразы, которых нет в прежних наборах
bank-v*: набор неизменяем, следующая партия банка — следующий набор. Каждая запись проходит
phone.py (8 кГц, полоса 300–3400 Гц, μ-law, подложка места) локально, без нового синтеза.
Манифест — как у dds-v3: seed сверяет текст реплики сценария и SHA-256 файла.
"""

from __future__ import annotations

import hashlib
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from phone import phone  # noqa: E402

# Где звучит доклад: в машине и на улице — улица, на работах в помещении — работы.
STREET_SLOTS = {
    "answer", "intro", "no_reply", "confirm_request", "repeat_report", "responding", "enroute",
    "delay", "wrong_place", "readback_fixed", "clarify", "clarify_ok", "clarify_unknown",
    "clarify_late", "ack", "not_understood", "end_call",
}  # fmt: skip
OUTDOOR = {
    "fire_street", "car_fire", "traffic", "tree", "collapse", "fight", "theft", "hooligan",
    "drunk", "missing", "car_theft", "suspicious", "gas_street", "pipe_damage", "unconscious",
    "injury", "roof",
}  # fmt: skip


def bed(speaker: str, phrase: dict[str, Any]) -> str:
    if speaker == "official":
        return "office"
    # Заявитель бытового сценария (HQ-019) вышла из дома: двор у магазина — улица.
    if speaker == "caller":
        return "street"
    incidents = set(phrase["incidents"])
    if phrase["slot"] in STREET_SLOTS or "*" in incidents or incidents & OUTDOOR:
        return "street"
    return "works"


def main() -> None:
    voice_set, root = sys.argv[1], Path(sys.argv[2]) / "data" / "voices"
    target = root / voice_set
    if (target / "manifest.json").exists():
        sys.exit(f"Набор {voice_set} уже выпущен и неизменяем — новая партия идёт новым набором.")
    known = set()
    for existing in root.glob("bank-v*/manifest.json"):
        known |= {
            item["id"] for item in json.loads(existing.read_text(encoding="utf-8"))["messages"]
        }
    bank = json.loads((HERE / "out" / "manifest.json").read_text(encoding="utf-8"))
    todo = [
        (service, book, phrase)
        for service, book in bank["services"].items()
        for phrase in book["phrases"]
        if phrase["id"] not in known
    ]

    def one(item: tuple[str, dict[str, Any], dict[str, Any]]) -> dict[str, Any]:
        service, book, phrase = item
        relative = f"{voice_set}/{service}/{phrase['id']}.ogg"
        seed = int(hashlib.sha256(phrase["id"].encode()).hexdigest()[:6], 16)
        millis = phone(HERE / phrase["audio"], root / relative, bed(book["speaker"], phrase), seed)
        return {
            "id": phrase["id"],
            "service_id": service,
            "slot": phrase["slot"],
            "path": relative,
            "text": phrase["text"],
            "voice": " ".join(
                (
                    "elevenlabs",
                    bank["model"],
                    book["voice"]["voice_id"],
                    f"({book['voice']['name']})",
                )
            ),
            "duration_ms": millis,
            "sha256": hashlib.sha256((root / relative).read_bytes()).hexdigest(),
            "media_type": "audio/ogg",
            **{key: phrase[key] for key in ("asks", "needs", "number") if key in phrase},
        }

    with ThreadPoolExecutor(max_workers=8) as pool:
        messages = list(pool.map(one, todo))
    manifest = {
        "version": 1,
        "note": "Банк фраз ДДС (scripts/voices/bank): ElevenLabs, голоса — scripts/voices/casting/"
        "voices.json, голос по телефону с подложкой (scripts/voices/phone.py). Набор неизменяем, "
        "следующая партия — следующий набор bank-vN. Пути относительно data/voices.",
        "messages": messages,
    }
    (target / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    size = sum(path.stat().st_size for path in target.rglob("*.ogg"))
    print(f"{voice_set}: {len(messages)} реплик, {size / 1e6:.1f} МБ — {target}")


if __name__ == "__main__":
    main()
