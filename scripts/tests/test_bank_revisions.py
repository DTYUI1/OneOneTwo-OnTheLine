"""Новые редакции фраз банка (HQ-037): окно телефона берёт новую фразу вместо старой, только
когда у новой есть запись; до синтеза звучит старая (scripts/voices/bank/web.py)."""

import importlib.util
import json
from pathlib import Path

BANK = Path(__file__).resolve().parents[2] / "scripts/voices/bank"


def load(name: str):
    spec = importlib.util.spec_from_file_location(f"bank_{name}", BANK / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def fake_bank(tmp_path: Path, recorded: list[str]) -> tuple[Path, Path]:
    here, voices = tmp_path / "bank", tmp_path / "voices"
    book = {"service": "OFFICIAL_103", "speaker": "official", "gender": "female"}
    write(
        here / "phrases" / "OFFICIAL_103.json",
        {
            **book,
            "phrases": [
                {"id": "OFFICIAL_103.end_call.any.1", "slot": "end_call", "text": "Всё, поняла."},
                {"id": "OFFICIAL_103.end_call.any.2", "slot": "end_call", "text": "До свидания."},
            ],
        },
    )
    write(
        here / "revisions" / "OFFICIAL_103.json",
        {
            **book,
            "phrases": [
                {
                    "id": "OFFICIAL_103.end_call.any.5",
                    "slot": "end_call",
                    "text": "Принято. До свидания.",
                    "replaces": "OFFICIAL_103.end_call.any.1",
                }
            ],
        },
    )
    messages = [{"id": pid, "path": f"bank-v1/OFFICIAL_103/{pid}.ogg"} for pid in recorded]
    write(voices / "bank-v1" / "manifest.json", {"messages": messages})
    return here, voices


def end_call(web) -> list[str]:
    data = json.loads(web.build())
    return [item["id"] for item in data["books"]["OFFICIAL_103"]["slots"]["end_call"]]


def test_revision_without_record_keeps_old_phrase(tmp_path, monkeypatch):
    web = load("web")
    here, voices = fake_bank(tmp_path, ["OFFICIAL_103.end_call.any.1"])
    monkeypatch.setattr(web, "HERE", here)
    monkeypatch.setattr(web, "VOICES", voices)
    assert end_call(web) == ["OFFICIAL_103.end_call.any.1", "OFFICIAL_103.end_call.any.2"]


def test_recorded_revision_takes_old_phrase_place(tmp_path, monkeypatch):
    web = load("web")
    recorded = ["OFFICIAL_103.end_call.any.1", "OFFICIAL_103.end_call.any.5"]
    here, voices = fake_bank(tmp_path, recorded)
    monkeypatch.setattr(web, "HERE", here)
    monkeypatch.setattr(web, "VOICES", voices)
    assert end_call(web) == ["OFFICIAL_103.end_call.any.5", "OFFICIAL_103.end_call.any.2"]


def test_bank_books_pass_check():
    """Книги банка, link112/ и revisions/ (HQ-036, HQ-037) — без ошибок bank.py check."""
    assert load("bank").check() == []


def code(root: Path, rel: str, pid: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f'export const BYE = "{pid}";\n', encoding="utf-8")


def test_code_refs_skip_tests(tmp_path):
    web = load("web")
    code(tmp_path, "apps/web/src/arm/bye.ts", "OFFICIAL_103.end_call.any.1")
    code(tmp_path, "apps/web/src/arm/bye.test.ts", "OFFICIAL_103.end_call.any.2")
    code(tmp_path, "apps/api/tests/test_bye.py", "OFFICIAL_103.end_call.any.2")
    assert web.code_refs(tmp_path) == {"OFFICIAL_103.end_call.any.1": ["apps/web/src/arm/bye.ts:1"]}


def test_window_refuses_code_id_replaced_by_recorded_revision(tmp_path, monkeypatch):
    """HQ-037: после записи редакции старый id уходит из выборки — код окна с ним упал бы
    при загрузке («Нет фразы банка»); web.py называет id редакции."""
    web = load("web")
    code(tmp_path, "apps/web/src/arm/bye.ts", "OFFICIAL_103.end_call.any.1")
    monkeypatch.setattr(web, "ROOT", tmp_path)
    here, voices = fake_bank(tmp_path, ["OFFICIAL_103.end_call.any.1"])
    monkeypatch.setattr(web, "HERE", here)
    monkeypatch.setattr(web, "VOICES", voices)
    assert web.code_problems(web.build()) == []
    here, voices = fake_bank(
        tmp_path, ["OFFICIAL_103.end_call.any.1", "OFFICIAL_103.end_call.any.5"]
    )
    assert web.code_problems(web.build()) == [
        "apps/web/src/arm/bye.ts:1: OFFICIAL_103.end_call.any.1 — "
        "поставьте OFFICIAL_103.end_call.any.5 (редакция)"
    ]


def test_bank_check_code_id_replaced_by_revision(tmp_path, monkeypatch):
    """bank.py check: редакция без записи — заметка «поправить код после записи», с записью —
    ошибка; несуществующий id в коде — ошибка."""
    bank = load("bank")
    here, voices = fake_bank(tmp_path, ["OFFICIAL_103.end_call.any.1"])
    monkeypatch.setattr(bank, "HERE", here)
    monkeypatch.setattr(bank.web, "ROOT", tmp_path)
    monkeypatch.setattr(bank.web, "VOICES", voices)
    ids = {p["id"]: p for book in bank.books() for p in book["phrases"]}
    code(tmp_path, "apps/web/src/arm/bye.ts", "OFFICIAL_103.end_call.any.1")
    problems, notes = bank.code_problems(ids)
    assert problems == []
    assert notes == [
        "apps/web/src/arm/bye.ts:1: OFFICIAL_103.end_call.any.1 — "
        "после записи OFFICIAL_103.end_call.any.5 поставить её id"
    ]
    fake_bank(tmp_path, ["OFFICIAL_103.end_call.any.1", "OFFICIAL_103.end_call.any.5"])
    assert bank.code_problems(ids) == (
        [
            "apps/web/src/arm/bye.ts:1: OFFICIAL_103.end_call.any.1 "
            "заменена записанной редакцией OFFICIAL_103.end_call.any.5"
        ],
        [],
    )
    code(tmp_path, "apps/web/src/arm/bye.ts", "OFFICIAL_103.end_call.any.9")
    assert bank.code_problems(ids)[0] == [
        "apps/web/src/arm/bye.ts:1: нет фразы банка OFFICIAL_103.end_call.any.9"
    ]


def test_code_ids_are_live_phrases():
    """Id фраз в коде (ASK_IDS, PHRASE_ID, CONTROL_*_ID) есть в банке и в выборке окна."""
    bank, web = load("bank"), load("web")
    ids = {p["id"]: p for book in bank.books() for p in book["phrases"]}
    assert web.code_refs(), "в коде нет ни одного id фразы — сменился вид id?"
    assert bank.code_problems(ids)[0] == []
    assert web.code_problems(web.build()) == []
