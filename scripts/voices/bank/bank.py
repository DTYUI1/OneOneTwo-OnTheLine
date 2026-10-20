"""Банк фраз озвучки ДДС: проверить, озвучить выбранными голосами, собрать манифест.

    python3 scripts/voices/bank/bank.py check       # проверить phrases/*.json
    python3 scripts/voices/bank/bank.py synth       # смета
    python3 scripts/voices/bank/bank.py synth --go  # озвучить то, чего ещё нет

Правила фраз — README.md рядом. Голоса — ../casting/voices.json. Кеш записей общий с
кастингом (../casting/out/cache): одна и та же фраза одним голосом второй раз не синтезируется.
out/<служба>/<id>.mp3 — записи под постоянными id, out/manifest.json — банк для сборщика
сценариев и страницы прослушивания.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "casting"))
sys.path.insert(0, str(HERE))
import casting  # noqa: E402
import web  # noqa: E402

OUT = HERE / "out"
SLOTS = {
    "brigade": {
        "answer",
        "intro",
        "no_reply",
        "confirm_request",
        "repeat_report",
        "briefing_ask",
        "refusal_busy",
        "refusal_not_assigned",
        "responding",
        "enroute",
        "delay",
        "wrong_place",
        "readback_fixed",
        "arrived",
        "working",
        "update",
        "status_working",
        "completed",
        "refused",
        "clarify",
        "clarify_ok",
        "clarify_unknown",
        "clarify_late",
        "request_service",
        # Служба вызвана заранее (GP-28): бригаде сказали «уже едут» / служба приехала сама.
        "service_coming",
        "service_surprise",
        "alarm",
        "alarm_ack",
        "ack",
        "not_understood",
        "end_call",
        # Фразы с адресом — только в addresses/ (addresses.py), в книгах phrases/ их нет.
        "readback",
        "readback_trap",
    },
    "official": {
        "answer",
        "accepted",
        "registered",
        "ask_who",
        "ask_address",
        "ask_what",
        "ask_card",
        "ask_victims",
        "not_understood",
        "end_call",
        # Звонок отдела контроля реагирования (TC-07): почему карточка без статуса.
        "control_ask",
    },
    # Живой заявитель бытового сценария (HQ-019, docs/dds_caller.md): книги callers/.
    "caller": {
        "answer",
        "answer_again",
        "ask_who",
        "tell_who",
        "tell_address",
        "tell_what",
        "tell_since",
        "tell_owner",
        "tell_people",
        "tell_danger",
        "tell_where",
        "tell_eta",
        "tell_box",
        # Диспетчер прочитал адрес вслух: верный — подтверждает, с ошибкой — поправляет.
        "confirm_address",
        "correct_address",
        "unknown",
        "repeat",
        "not_understood",
        "agree",
        "no_reply",
        "hangup",
        "end_call",
    },
}
# Когда звучит реплика заявителя (on): у tell_* first — неполный ответ (сведение ещё не
# получено), again — на уточнение; у repeat first — первый повтор, again — второй и дальше.
# Без on реплики одного места взаимозаменяемы.
CALLER_TURNS = {"first", "again"}
# Что неверно в адресе, который прочитал диспетчер (correct_address): дом или квартира.
ADDRESS_MISTAKES = {"house", "flat"}
FACTS = {
    "victims",
    "no_victims",
    "blocked",
    "victim_male",
    "victim_female",
    "victim_child",
    "victim_elderly",
    "hospitalized",
    "refused_hospital",
    "evacuated",
    "no_access",
    "false_call",
    "gone",
    "self_resolved",
    "other_org",
    "detained",
    "handed_103",
    "handed_102",
    "fire",
    "no_fire",
    "gas",
    "no_gas",
}
SERVICES = {"101", "102", "103", "104", "GKH", "MOSLIFT"}
# Места, где фраза говорит о другой службе: `needs` — какой.
NEEDS_SLOTS = {"request_service", "service_coming", "service_surprise"}
# Первое лицо прошедшего времени мужского рода — у женского голоса так говорить нельзя.
MASCULINE = re.compile(r"\b(понял|принял|услышал|осмотрел|записал)\b", re.I)


def books() -> list[dict]:
    """Книги phrases/, фразы бригад с адресом addresses/ (повтор адреса вводной), реплики
    сюжетов связки 112 → ДДС link112/ (app.seed.link112 берёт запись по службе и тексту),
    новые редакции фраз revisions/ (`replaces` — какую фразу заменяют, web.py) и реплики
    живого заявителя callers/ (HQ-019: книга на характер, окно телефона — web.py)."""
    return [
        json.loads(path.read_text(encoding="utf-8"))
        for folder in ("phrases", "addresses", "link112", "revisions", "callers")
        for path in sorted((HERE / folder).glob("*.json"))
    ]


def spoken(phrase: dict) -> str:
    """Текст, который уходит в синтез: тег подачи v4 и фраза (`say` — числа словами)."""
    text = phrase.get("say", phrase["text"])
    return f"{phrase['tone']} {text}" if phrase.get("tone") else text


def check() -> list[str]:
    problems: list[str] = []
    ids: set[str] = set()
    texts: dict[tuple[str, str], str] = {}
    slots_by_id = {
        phrase["id"]: (book["service"], phrase["slot"])
        for book in books()
        for phrase in book["phrases"]
    }
    for book in books():
        service, slots = book["service"], SLOTS[book["speaker"]]
        known = set(book.get("incidents", {})) | {"*"}
        for phrase in book["phrases"]:
            pid, text = phrase["id"], phrase["text"]
            where = f"{service} {pid}"
            if pid in ids:
                problems.append(f"{where}: id повторяется")
            ids.add(pid)
            if not pid.startswith(f"{service}.{phrase['slot']}."):
                problems.append(f"{where}: id не по виду <служба>.<slot>.…")
            if phrase["slot"] not in slots:
                problems.append(f"{where}: нет такого slot «{phrase['slot']}»")
            requires = phrase.get("requires")
            # Эту реплику нельзя случайно поставить в нормальный сценарий: условие
            # проверяет мир, а обычный генератор исключает условные фразы из пула.
            guarded_briefing = ".update.wrong_briefing." in pid
            if "requires" in phrase and requires != ["wrong_briefing"]:
                problems.append(f"{where}: requires — непустой список известных условий")
            if guarded_briefing and requires != ["wrong_briefing"]:
                problems.append(f"{where}: реплика неверной вводной без requires wrong_briefing")
            if requires == ["wrong_briefing"] and (
                book["speaker"] != "brigade" or phrase["slot"] != "update"
            ):
                problems.append(f"{where}: wrong_briefing — только update бригады")
            for incident in phrase.get("incidents", []):
                if incident not in known:
                    problems.append(f"{where}: нет такого происшествия «{incident}»")
            for fact in phrase.get("facts", []):
                if fact not in FACTS:
                    problems.append(f"{where}: нет такого факта «{fact}»")
            if phrase["slot"] in NEEDS_SLOTS and phrase.get("needs") not in SERVICES:
                problems.append(f"{where}: {phrase['slot']} без needs")
            if phrase["slot"] == "registered" and not str(phrase.get("number", "")).isdigit():
                problems.append(f"{where}: registered без number цифрами")
            if "replaces" in phrase and slots_by_id.get(phrase["replaces"]) != (
                service,
                phrase["slot"],
            ):
                problems.append(f"{where}: replaces — не фраза того же места этой книги")
            if re.search(r"[0-9A-Za-z]", phrase.get("say", text)):
                problems.append(f"{where}: цифры или латиница в тексте")
            if book["gender"] == "female" and MASCULINE.search(text):
                problems.append(f"{where}: мужской род у женского голоса — «{text}»")
            key = (service, text.lower().strip(" .!?"))
            if key in texts:
                problems.append(f"{where}: тот же текст, что у {texts[key]}")
            texts[key] = pid
        if book["speaker"] == "caller":
            problems += caller_problems(book)
    problems += code_problems(slots_by_id)[0]
    problems += web.caller_plot_problems()
    plots: dict[tuple[str, ...], dict] = {}
    for book in books():
        if book["speaker"] != "caller":
            continue
        incidents = tuple(sorted(book.get("incidents", {})))
        if plots.setdefault(incidents, book["plot_facts"]) != book["plot_facts"]:
            problems.append(f"{book['service']}: сведения сюжета не те, что у другого характера")
    return problems


def code_problems(slots_by_id: dict) -> tuple[list[str], list[str]]:
    """Id фраз, записанные в коде (ASK_IDS, PHRASE_ID, CONTROL_*_ID; web.code_refs), — что с
    ними не так (ошибки) и что поправить в коде после синтеза (заметки), HQ-037.

    Редакция (`replaces`) с записью убирает старую фразу из выборки окна телефона — код с
    её id падает при загрузке. Без записи старая ещё звучит: заметка, а не ошибка, — иначе
    редакцию такой фразы не подготовить до синтеза."""
    services = {pid.split(".")[0] for pid in slots_by_id}
    voiced = web.recorded()
    replaced = {
        phrase["replaces"]: phrase["id"]
        for book in books()
        for phrase in book["phrases"]
        if "replaces" in phrase
    }
    problems: list[str] = []
    notes: list[str] = []
    for pid, places in web.code_refs().items():
        if pid.split(".")[0] not in services:
            continue
        for where in places:
            if pid not in slots_by_id:
                problems.append(f"{where}: нет фразы банка {pid}")
            elif pid in replaced and replaced[pid] in voiced:
                problems.append(f"{where}: {pid} заменена записанной редакцией {replaced[pid]}")
            elif pid in replaced:
                notes.append(f"{where}: {pid} — после записи {replaced[pid]} поставить её id")
    return problems, notes


def caller_problems(book: dict) -> list[str]:
    """Заявитель (HQ-019): каждое сведение сюжета звучит хотя бы в одной реплике, реплика
    говорит только о сведениях сюжета, неполный ответ (`on: first`) сведения не даёт,
    поправка адреса есть на каждую ошибку (`wrong`: дом, квартира)."""
    problems: list[str] = []
    facts = set(book.get("plot_facts", {}))
    told: set[str] = set()
    corrected: set[str] = set()
    for phrase in book["phrases"]:
        where = f"{book['service']} {phrase['id']}"
        tells = set(phrase.get("tells", []))
        if tells - facts:
            problems.append(f"{where}: нет таких сведений сюжета {sorted(tells - facts)}")
        turn = phrase.get("on")
        if turn is not None and turn not in CALLER_TURNS:
            problems.append(f"{where}: on — first или again")
        if turn == "first" and tells:
            problems.append(f"{where}: неполный ответ (on: first) не даёт сведений")
        if phrase["slot"] == "correct_address":
            if phrase.get("wrong") not in ADDRESS_MISTAKES:
                problems.append(f"{where}: correct_address без wrong (house или flat)")
            corrected.add(phrase.get("wrong"))
        told |= tells
    if facts - told:
        problems.append(f"{book['service']}: не звучат сведения {sorted(facts - told)}")
    if ADDRESS_MISTAKES - corrected:
        missing = sorted(ADDRESS_MISTAKES - corrected)
        problems.append(f"{book['service']}: нет поправки адреса {missing}")
    return problems


def synth(go: bool) -> None:
    problems = check()
    if problems:
        sys.exit("Сначала поправить:\n" + "\n".join(problems))
    voices = json.loads((HERE.parent / "casting" / "voices.json").read_text(encoding="utf-8"))
    cast = {"model": voices["model"]}
    clips = []
    for book in books():
        voice = voices["voices"][book["service"]]
        for phrase in book["phrases"]:
            text = spoken(phrase)
            file = casting.CACHE / f"{casting.clip_key(cast, voice['voice_id'], text)}.mp3"
            clips.append(
                {"book": book, "phrase": phrase, "voice": voice, "text": text, "file": file}
            )
    todo = [clip for clip in clips if not clip["file"].exists()]
    ids = {clip["phrase"]["id"]: clip["phrase"] for clip in clips}
    for note in code_problems(ids)[1]:
        print(f"код: {note}")
    chars = sum(len(clip["text"]) for clip in todo)
    print(
        f"модель {cast['model']}: фраз {len(clips)}, готово {len(clips) - len(todo)}, "
        f"озвучить {len(todo)} — {chars} символов"
    )
    if todo and not go:
        print(f"кредитов осталось: {casting.credits_left()}. Озвучить: synth --go")
        return
    casting.CACHE.mkdir(parents=True, exist_ok=True)

    def one(numbered: tuple[int, dict]) -> None:
        number, clip = numbered
        clip["file"].write_bytes(casting.tts(cast, clip["voice"], clip["text"]))
        print(f"  {number}/{len(todo)} {clip['phrase']['id']}: {clip['text']}", flush=True)

    # Четыре запроса разом: укладывается в лимит одновременных запросов младших тарифов.
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(one, enumerate(todo, start=1)))
    publish(cast, clips)


def publish(cast: dict, clips: list[dict]) -> None:
    # Записи под id собираются заново; verify.json (проверка Whisper) остаётся.
    for folder in OUT.iterdir() if OUT.exists() else []:
        if folder.is_dir():
            shutil.rmtree(folder)
    manifest: dict = {"model": cast["model"], "services": {}}
    for clip in clips:
        book, phrase = clip["book"], clip["phrase"]
        target = OUT / book["service"] / f"{phrase['id']}.mp3"
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(clip["file"], target)
        service = manifest["services"].setdefault(
            book["service"],
            {
                "voice": clip["voice"],
                "speaker": book["speaker"],
                "incidents": book.get("incidents", {}),
                "phrases": [],
            },
        )
        service["phrases"].append(
            {
                **phrase,
                "audio": str(target.relative_to(HERE)),
                "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
            }
        )
    casting.save(OUT / "manifest.json", manifest)
    print(f"Банк — {OUT}. Слушать: python3 scripts/voices/casting/casting.py serve → /bank/")


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "check":
        found = check()
        print("\n".join(found) or f"ок: {sum(len(b['phrases']) for b in books())} фраз")
        ids = {phrase["id"]: phrase for book in books() for phrase in book["phrases"]}
        for note in code_problems(ids)[1]:
            print(f"код: {note}")
        sys.exit(1 if found else 0)
    elif command == "synth":
        synth("--go" in sys.argv)
    else:
        sys.exit(__doc__)
