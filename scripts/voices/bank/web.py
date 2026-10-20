"""Фразы банка, которые окно телефона говорит само, → apps/web/src/arm/softphone/bankPhrases.json.

    python3 scripts/voices/bank/web.py          # записать файл и записи
    python3 scripts/voices/bank/web.py --check  # файл и записи совпадают с банком?

Реплики сценариев приходят с сервера; в бандл идут только ответы бригады в разговоре (GP-11,
TC-01), реплики должностных лиц (TC-03) и живого заявителя (книги callers/, HQ-019,
docs/dds_caller.md) — места разговора ниже, все фразы этих мест. У фраз заявителя — ещё `on`
(неполный ответ или уточнение, первый или второй повтор), `wrong` (что поправляет в адресе) и
`tells` (какое сведение сюжета звучит), а таблицы сюжетов заявителя (callers/plots/: вопросы
диспетчера и как их узнать во фразе) — в `callerPlots`. Файл неизменно форматирован
(prettier его не меняет): без массивов строк, ключи по порядку банка.

Записи этих фраз (GP-28) — копии наборов data/voices/bank-v* в apps/web/src/arm/softphone/bank/
<id>.ogg: окно телефона играет их само, офлайн. Повтор адреса вводной (`readback`) — из книг
addresses/ (addresses.py): сервер присылает текст, окно находит его запись.

Новая редакция фразы (revisions/, поле `replaces`) встаёт на место старой, только когда у неё
есть запись в наборах bank-v*: до синтеза окно говорит старой фразой и её записью. Код окна,
который берёт фразу по id (ASK_IDS, PHRASE_ID, CONTROL_*_ID), после этого должен ссылаться на
редакцию: web.py не пишет выборку, где id из кода нет (HQ-037), и называет, чем его заменить.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
TARGET = ROOT / "apps" / "web" / "src" / "arm" / "softphone" / "bankPhrases.json"
AUDIO = TARGET.parent / "bank"
VOICES = ROOT / "data" / "voices"
# Код, который берёт фразы банка по id. Тесты не в счёт: им фраза нужна как пример.
CODE_ROOTS = ("apps/web/src", "apps/api/app", "packages")
SKIP_DIRS = {"node_modules", "dist", "tests", "__pycache__", ".venv"}
ID_LITERAL = re.compile(r"""["']([0-9A-Z][0-9A-Z_]*\.[a-z_]+\.[0-9A-Za-z_]+\.[0-9]+)["']""")
SLOTS = {
    "brigade": (
        "answer",
        "intro",
        "no_reply",
        "confirm_request",
        "repeat_report",
        "ack",
        "not_understood",
        "end_call",
        "enroute",
        "status_working",
        "briefing_ask",
        "refusal_busy",
        "refusal_not_assigned",
        "readback",
        # «Понял, ждём пожарных»: диспетчер сказал, что служба вызвана (GP-28).
        "service_coming",
    ),
    "official": (
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
        "control_ask",
    ),
    # Живой заявитель (HQ-019): все места книг callers/ — разговор ведёт окно телефона.
    "caller": (
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
        "confirm_address",
        "correct_address",
        "unknown",
        "repeat",
        "not_understood",
        "agree",
        "no_reply",
        "hangup",
        "end_call",
    ),
}


def phrase_row(phrase: dict) -> dict:
    row = {"id": phrase["id"], "text": phrase["text"]}
    if "asks" in phrase:
        row["asks"] = phrase["asks"]
    if "needs" in phrase and phrase["slot"] == "service_coming":
        row["needs"] = phrase["needs"]
    if "number" in phrase:
        row["number"] = str(phrase["number"])
    # Заявитель (HQ-019): когда звучит, что поправляет в адресе, какое сведение даёт.
    for key in ("on", "wrong"):
        if key in phrase:
            row[key] = phrase[key]
    if phrase.get("tells"):
        row["tells"] = ",".join(phrase["tells"])
    incidents = phrase.get("incidents", ["*"])
    if incidents != ["*"]:
        # Только для одного происшествия (у должностных лиц — s112, оператор 112).
        row["only"] = ",".join(incidents)
    return row


def recorded() -> dict[str, Path]:
    """Id фразы → файл записи в наборах data/voices/bank-v* (id постоянен)."""
    return {
        item["id"]: VOICES / item["path"]
        for manifest in sorted(VOICES.glob("bank-v*/manifest.json"))
        for item in json.loads(manifest.read_text(encoding="utf-8"))["messages"]
        if "id" in item
    }


def revisions(voiced: set[str] | dict[str, Path]) -> dict[str, dict]:
    """Id старой фразы → её новая редакция (revisions/), у которой уже есть запись."""
    found: dict[str, dict] = {}
    for path in sorted((HERE / "revisions").glob("*.json")):
        for phrase in json.loads(path.read_text(encoding="utf-8"))["phrases"]:
            if phrase["id"] in voiced:
                found[phrase["replaces"]] = phrase
    return found


def code_refs(root: Path | None = None) -> dict[str, list[str]]:
    """Id фраз банка, записанные в коде (строкой), → где: «файл:строка»."""
    root = root or ROOT
    refs: dict[str, list[str]] = {}
    for top in CODE_ROOTS:
        for folder, dirs, files in os.walk(root / top):
            dirs[:] = sorted(name for name in dirs if name not in SKIP_DIRS)
            for name in sorted(files):
                if not name.endswith((".ts", ".tsx", ".py")) or ".test." in name:
                    continue
                if name.startswith("test_"):
                    continue
                path = Path(folder) / name
                lines = path.read_text(encoding="utf-8").splitlines()
                for number, line in enumerate(lines, start=1):
                    for pid in ID_LITERAL.findall(line):
                        where = f"{path.relative_to(root).as_posix()}:{number}"
                        refs.setdefault(pid, []).append(where)
    return refs


def code_problems(text: str) -> list[str]:
    """Id из кода окна телефона, которых нет в выборке `text`: модуль упадёт при загрузке
    («Нет фразы банка …»). Чаще всего фразу сменила записанная редакция — её id и назвать."""
    data = json.loads(text)
    have = {
        phrase["id"]
        for book in data["books"].values()
        for phrases in book["slots"].values()
        for phrase in phrases
    }
    newer = revisions(recorded())
    problems = []
    for pid, places in code_refs().items():
        if pid in have or pid.split(".")[0] not in data["books"]:
            continue
        hint = f"поставьте {newer[pid]['id']} (редакция)" if pid in newer else "нет в выборке"
        web = [where for where in places if where.startswith("apps/web/")]
        problems += [f"{where}: {pid} — {hint}" for where in web]
    return problems


def caller_plots() -> dict[str, dict]:
    """Таблицы сюжетов живого заявителя (callers/plots/<сюжет>.json, HQ-019): вопросы
    диспетчера, слова, по которым окно телефона их узнаёт, повод и просьба подойти."""
    return {
        path.stem: json.loads(path.read_text(encoding="utf-8"))
        for path in sorted((HERE / "callers" / "plots").glob("*.json"))
    }


def caller_plot_problems() -> list[str]:
    """Сюжет заявителя целиком или никак: у каждого сюжета книг заявителя есть таблица, у
    каждой таблицы — реплики во всех книгах (характерах), её сведения — `plot_facts` книг, а
    слова распознавания — регулярные выражения. Иначе окно телефона молча не нашло бы книгу
    характера и звонок заявителю ушёл бы дежурному службы."""
    plots = caller_plots()
    problems: list[str] = []
    books = [
        json.loads(path.read_text(encoding="utf-8"))
        for path in sorted((HERE / "callers").glob("*.json"))
    ]
    for plot, table in plots.items():
        if table.get("plot") != plot:
            problems.append(f"callers/plots/{plot}.json: plot не «{plot}»")
        if "come_requires" in table:
            required = table["come_requires"]
            facts = table.get("facts", {})
            valid = (
                isinstance(required, list)
                and bool(required)
                and all(isinstance(fact, str) for fact in required)
                and len(required) == len(set(required))
                and all(fact in facts and facts[fact].get("key") is True for fact in required)
            )
            if not valid:
                problems.append(
                    f"callers/plots/{plot}.json: come_requires — нужен непустой список "
                    "уникальных ключевых сведений сюжета"
                )
        fields = {"reason": table.get("reason"), "come": table.get("come")}
        for fact, item in table.get("facts", {}).items():
            fields |= {f"{fact}.ask": item.get("ask"), f"{fact}.hear": item.get("hear")}
        for key, value in fields.items():
            if not isinstance(value, str) or not value:
                problems.append(f"callers/plots/{plot}.json: нет {key}")
            elif key == "reason" or key.endswith(".hear"):
                try:
                    re.compile(value)
                except re.error as error:
                    problems.append(f"callers/plots/{plot}.json: {key} — {error}")
    for book in books:
        own = {i for phrase in book["phrases"] for i in phrase.get("incidents", [])}
        for plot in sorted(own - set(plots)):
            problems.append(f"{book['service']}: сюжета «{plot}» нет в callers/plots/")
        for plot in sorted(set(plots) - own):
            problems.append(f"{book['service']}: нет реплик сюжета «{plot}» (callers/plots/)")
        for plot in sorted(own & set(plots)):
            facts = list(plots[plot].get("facts", {}))
            if sorted(facts) != sorted(book.get("plot_facts", {})):
                problems.append(
                    f"{book['service']}: plot_facts не те, что в callers/plots/{plot}.json"
                )
    return problems


def build() -> str:
    books = {}
    newer = revisions(recorded())
    # Фразы с адресом — в книгу своей службы (addresses/<служба>.json рядом с phrases/).
    extra: dict[str, list[dict]] = {}
    for path in sorted((HERE / "addresses").glob("*.json")):
        book = json.loads(path.read_text(encoding="utf-8"))
        extra[book["service"]] = book["phrases"]
    paths = sorted((HERE / "phrases").glob("*.json")) + sorted((HERE / "callers").glob("*.json"))
    for path in paths:
        book = json.loads(path.read_text(encoding="utf-8"))
        phrases = [
            newer.get(phrase["id"], phrase)
            for phrase in book["phrases"] + extra.get(book["service"], [])
        ]
        slots = {
            slot: [phrase_row(p) for p in phrases if p["slot"] == slot]
            for slot in SLOTS[book["speaker"]]
        }
        entry = {"speaker": book["speaker"], "gender": book["gender"]}
        if book.get("character"):
            entry["character"] = book["character"]
        books[book["service"]] = {**entry, "slots": {k: v for k, v in slots.items() if v}}
    data = {
        "note": "Сгенерировано scripts/voices/bank/web.py из scripts/voices/bank/phrases — "
        "руками не править.",
        "books": books,
        # Пояснение таблицы (`about`) окну не нужно.
        "callerPlots": {
            plot: {key: value for key, value in table.items() if key != "about"}
            for plot, table in caller_plots().items()
        },
    }
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


def audio() -> dict[str, bytes]:
    """Записи фраз выборки: имя файла → содержимое из наборов bank-v* (id постоянен)."""
    paths = recorded()
    data = json.loads(build())
    ids = [
        phrase["id"]
        for book in data["books"].values()
        for phrases in book["slots"].values()
        for phrase in phrases
    ]
    return {f"{pid}.ogg": paths[pid].read_bytes() for pid in ids if pid in paths}


def main() -> None:
    problems = caller_plot_problems()
    if problems:
        sys.exit("Сюжеты живого заявителя (callers/plots/):\n" + "\n".join(problems))
    text = build()
    problems = code_problems(text)
    if problems:
        sys.exit("Код окна телефона ссылается на фразы не из выборки:\n" + "\n".join(problems))
    files = audio()
    if "--check" in sys.argv:
        if not TARGET.exists() or TARGET.read_text(encoding="utf-8") != text:
            sys.exit(f"{TARGET.relative_to(ROOT)} устарел: python3 scripts/voices/bank/web.py")
        have = {path.name: path.read_bytes() for path in AUDIO.glob("*.ogg")}
        if have != files:
            sys.exit(f"{AUDIO.relative_to(ROOT)} устарел: python3 scripts/voices/bank/web.py")
        print(f"ок: {TARGET.relative_to(ROOT)}, записей {len(files)}")
        return
    TARGET.write_text(text, encoding="utf-8")
    AUDIO.mkdir(exist_ok=True)
    for path in AUDIO.glob("*.ogg"):
        if path.name not in files:
            path.unlink()
    for name, content in files.items():
        (AUDIO / name).write_bytes(content)
    print(f"записан {TARGET.relative_to(ROOT)} и {len(files)} записей в {AUDIO.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
