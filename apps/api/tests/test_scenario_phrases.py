"""GP-25: реплики сценариев — фразы банка озвучки (scripts/voices/bank).

Правила — contracts/scenario-events.md, «Реплики — из банка озвученных фраз», и README банка,
«Как сборщик сценариев берёт фразы». Реплика бригады в сценарии — дословно текст фразы банка
своей службы: место в разговоре (slot) по шагу сценария, происшествие сценария или «*». Факты
фраз не спорят с карточкой и между собой, фраза в сценарии не повторяется.

Не из банка — повтор адреса с ошибкой (реплика события readback_error) и реплики из AWAITING:
фразы под них в банке ещё нет, они остаются текстом прежней версии, пока сессия озвучки не
допишет фразу (тот же список — scripts/ralph/gameplay/handoff.md). GP-28: список пуст, реплики
из банка звучат записями набора bank-v<N> (data/voices/bank-v1, scripts/voices/bank/port.py).

Проверяются сценарии, изменённые или добавленные с GP-25: все файлы data/scenarios, кроме
перенесённых из data/practice без правок (LEGACY — код и версия на момент переноса).
"""

import copy
import hashlib
import importlib.util
import json
from dataclasses import dataclass
from functools import cache
from typing import Any

import pytest
from app.api.training import briefing
from app.core.config import ROOT
from app.seed.scenarios import SCENARIOS_DIR, line_text
from app.seed.service_defaults import with_service_defaults

BANK_DIR = ROOT / "scripts" / "voices" / "bank" / "phrases"
VOICES_DIR = ROOT / "data" / "voices"

# Перенесены из data/practice (GP-03, версия 2 — GP-04) и с тех пор не менялись: реплики с
# записями Piper. С 17.10 все перенесённые сценарии озвучены банком (bank-v2) — список пуст.
LEGACY: dict[str, int] = {}

# Вид происшествия сценария (классификатор, incident_type_code) → происшествие банка службы.
# Нет в словаре — в банке такого происшествия нет: подходят только фразы с incidents ["*"].
BANK_INCIDENT = {
    ("101", "1050101"): "fire_flat",  # пожар: квартира
    ("101", "14080104"): "tree",  # дерево упало на машину
    ("102", "17020201"): "missing",  # пропал несовершеннолетний
    ("102", "15210101"): "car_theft",  # угон машины до 30 минут
    ("103", "22350000"): "stroke",  # парализовало, подозрение на инсульт
    ("103", "22520000"): "child",  # температура у ребёнка
    ("104", "13010500"): "gas_street",  # запах газа от колодца
    ("101", "1020201"): "car_fire",  # пожар: машина
    ("101", "17080400"): "door",  # открыть дверь: ребёнок
    ("102", "15050300"): "theft",  # кража
    ("102", "15190000"): "domestic",  # семейный скандал
    ("103", "22530000"): "fall",  # травма после падения
    ("104", "22340200"): "co",  # отравление угарным газом
    ("MOSLIFT", "14100100"): "lift_stuck",  # застревание без медпомощи
    ("101", "1050102"): "smoke",  # задымление в квартире
    ("102", "2021700"): "traffic",  # ДТП с заблокированными
    ("102", "2010100"): "traffic",  # ДТП без пострадавших, легковой
    ("103", "22360000"): "heart",  # плохо: давление, боль за грудиной
    ("104", "13020500"): "gas_flat",  # запах газа в многоквартирном доме
    ("104", "14020300"): "pipe_basement",  # течь в подвале
    ("GKH", "21040100"): "animal",  # спасти животное
    # Один класс включает прорывы водопровода, отопления и протечку от соседей.
    ("GKH", "14020300"): ("pipe_flat", "leak_ceiling", "heating"),
    ("GKH", "14010300"): "no_water",  # отключение водоснабжения
    ("GKH", "14041500"): "sewer",  # засор внутренней канализации
    ("GKH", "14050300"): "electric",  # неисправность электрощитовой
    ("GKH", "14030100"): "roof",  # коммунальная проблема: протекает кровля
    ("102", "15250501"): "fight",  # драка на улице
    ("103", "15250501"): "injury",  # травма в драке
    ("101", "13020201"): "gas_smell",  # запах бытового газа в квартире
    ("104", "13020201"): "gas_flat",
    ("103", "22370000"): "heart",  # плохо с сердцем
    ("101", "14100101"): "lift",  # застревание в лифте, нужна медпомощь
    ("103", "14100101"): "lift",
    ("MOSLIFT", "14100101"): "lift_ill",
    ("MOSLIFT", "14100102"): "lift_child",  # ребёнок без взрослых
    ("MOSLIFT", "14100700"): "lift_fault",  # не закрываются двери лифта
    ("MOSLIFT", "1050502"): "lift_fire",  # задымление: лифт
    ("102", "1050102"): "smoke",
    ("103", "1050102"): "smoke",
    ("104", "1050102"): "smoke",
    ("101", "2021700"): "traffic",
    ("103", "2021700"): "traffic",
}

# Фразы под эти реплики в банке нет: (код сценария, место) → (slot, нужный смысл). Реплика
# остаётся текстом прежней версии; появится фраза — реплику заменить, запись удалить.
AWAITING: dict[tuple[str, str], tuple[str, str]] = {}

PLAN_SLOTS = {state: {state} for state in ("responding", "arrived", "working", "completed")}
PLAN_SLOTS["refused"] = {"refused"}
EVENT_SLOTS = {
    "clarify": {"clarify"},
    "request_service": {"request_service"},
    "silence": {"status_working"},
    "alarm": {"alarm"},
}
BRANCH_SLOTS: dict[str, dict[str, set[str]]] = {
    "clarify": {
        "met": {"clarify_ok"},
        "wrong": {"clarify_unknown"},
        "missed": {"clarify_unknown"},
        "late": {"clarify_late"},
    },
    "request_service": {
        "met": {"ack", "status_working"},
        "late": {"ack", "status_working"},
        "missed": {"request_service"},
        # Служба вызвана заранее (GP-28): ветки достраивает загрузчик, если их нет в файле.
        "already": {"service_coming"},
        "surprise": {"service_surprise"},
    },
    "silence": {branch: {"status_working"} for branch in ("met", "wrong", "late", "missed")},
    "alarm": {branch: {"alarm_ack"} for branch in ("met", "wrong", "late", "missed")},
    "readback_error": {"met": {"readback_fixed"}},
}
# Места, где фраза называет другую службу: её `needs` — из номеров ожидания события.
NEEDS_SLOTS = {"request_service", "service_coming", "service_surprise"}
# Факты, которые не могут быть правдой в одном сценарии.
OPPOSITE = (
    ("victims", "no_victims"),
    ("victim_male", "victim_female"),
    ("victim_child", "victim_elderly"),
    ("fire", "no_fire"),
    ("gas", "no_gas"),
    ("hospitalized", "refused_hospital"),
)


@cache
def voice_manifest(folder: str) -> dict[str, dict[str, Any]]:
    """Манифест набора озвучки: путь → запись (text, sha256)."""
    path = VOICES_DIR / folder / "manifest.json"
    if not path.exists():
        return {}
    messages = json.loads(path.read_text(encoding="utf-8"))["messages"]
    return {item["path"]: item for item in messages}


def load_bank() -> dict[str, dict[str, dict[str, Any]]]:
    """Служба → текст фразы → фраза. Текст в книге службы уникален (bank.py check).

    Фразы, собранные по сценариям (addresses/: повтор адреса, «переехали по карточке»), —
    в книге той же службы."""
    bank: dict[str, dict[str, dict[str, Any]]] = {}
    for folder in (BANK_DIR, BANK_DIR.parent / "addresses"):
        for path in sorted(folder.glob("*.json")):
            book = json.loads(path.read_text(encoding="utf-8"))
            bank.setdefault(book["service"], {}).update(
                {phrase["text"]: phrase for phrase in book["phrases"]}
            )
    return bank


BANK = load_bank()
SERVICE_BY_EXT = {
    item["phone_ext"]: item["id"]
    for item in json.loads((ROOT / "data" / "phonebook.json").read_text(encoding="utf-8"))
}


def scenario_files() -> list[dict[str, Any]]:
    return [
        json.loads(path.read_text(encoding="utf-8"))
        for path in sorted(SCENARIOS_DIR.glob("*.json"))
    ]


def checked(data: dict[str, Any]) -> bool:
    return LEGACY.get(data["code"]) != data["version"]


CHECKED = [data for data in scenario_files() if checked(data)]


@dataclass(frozen=True)
class Place:
    """Реплика сценария и какие места разговора ей подходят."""

    where: str
    line: str | dict[str, Any]
    slots: frozenset[str]
    # Повтор адреса с ошибкой: в реплике адрес, в банке её нет.
    readback: bool = False
    # request_service: какие службы просят вызвать (номера из ожидания call_service).
    needs: frozenset[str] = frozenset()


def places(data: dict[str, Any]) -> list[Place]:
    """Все реплики бригад сценария: доклады плана, реплики событий, ветки и подмены.

    Как в плане после загрузки: с ветками «служба вызвана заранее» (GP-28), которые
    загрузчик достраивает из банка (`service_defaults.with_service_defaults`)."""
    data = with_service_defaults(data)
    reports = {report["key"]: report for report in data["plan"]}
    # Доклад, который меняет задачу (TC-05), — фраза своего места или «обстановка изменилась».
    found = [
        Place(
            f"plan:{key}",
            report["line"],
            frozenset(
                PLAN_SLOTS[report["justifies_state"]]
                | ({"update"} if "task_change" in report else set())
            ),
        )
        for key, report in reports.items()
    ]
    for event in data.get("events", []):
        kind, key = event["kind"], event["key"]
        # Номер в ожидании — внутренний (105, 106); у фразы needs — служба (GKH, MOSLIFT).
        needs = frozenset(
            SERVICE_BY_EXT.get(ext, ext)
            for expect in event["expect"]
            if expect["action"] == "call_service"
            for ext in expect.get("phone_exts", [])
        )
        if event["line"] is not None:
            found.append(
                Place(
                    f"event:{key}",
                    event["line"],
                    frozenset(EVENT_SLOTS.get(kind, set())),
                    readback=kind == "readback_error",
                    needs=needs if kind == "request_service" else frozenset(),
                )
            )
        for branch, body in event["branches"].items():
            if body["line"] is not None:
                slots = BRANCH_SLOTS.get(kind, {}).get(branch, set())
                found.append(
                    Place(
                        f"event:{key}:{branch}",
                        body["line"],
                        frozenset(slots),
                        needs=needs if kind == "request_service" else frozenset(),
                    )
                )
            # Ветки «вызвана заранее» наследуют последствия met: та же подмена — та же реплика.
            met = event["branches"].get("met", {}).get("effects")
            inherited = branch in ("already", "surprise") and body["effects"] == met
            for effect in [] if inherited else body["effects"]:
                if "replace" not in effect:
                    continue
                target = reports[effect["replace"]]["justifies_state"]
                slots = {"wrong_place"} if kind == "readback_error" else PLAN_SLOTS[target]
                found.append(
                    Place(
                        f"event:{key}:{branch}:replace:{effect['replace']}",
                        effect["with"],
                        frozenset(slots),
                    )
                )
    return found


def bank_phrases(data: dict[str, Any]) -> list[tuple[Place, dict[str, Any]]]:
    """Реплики сценария, взятые из банка, с их фразами (повтор адреса и AWAITING — без фраз)."""
    book = BANK[data["service_id"]]
    return [
        (place, book[line_text(place.line)])
        for place in places(data)
        if line_text(place.line) in book
    ]


def test_bank_books_cover_scenario_services() -> None:
    """Книга банка есть у каждой службы проверяемого сценария (бригады — служба сценария)."""
    assert CHECKED, "нет сценариев по правилам банка"
    for data in CHECKED:
        assert data["service_id"] in BANK, data["code"]


@pytest.mark.parametrize("data", CHECKED, ids=lambda data: data["code"])
def test_every_line_is_a_bank_phrase(data: dict[str, Any]) -> None:
    """Реплика — дословно фраза банка своей службы на своём месте разговора и происшествии."""
    code, service = data["code"], data["service_id"]
    book = BANK[service]
    incident = BANK_INCIDENT.get((service, data["incident_type_code"]))
    incidents = (incident,) if isinstance(incident, str) else incident or ()
    allowed = {"*", *incidents}
    for place in places(data):
        text = line_text(place.line)
        if place.readback:
            continue
        phrase = book.get(text)
        if phrase is None:
            assert (code, place.where) in AWAITING, (
                f"{code} {place.where}: «{text}» — нет такой фразы в банке службы {service}"
            )
            slot, _ = AWAITING[(code, place.where)]
            assert slot in place.slots, (code, place.where, slot, sorted(place.slots))
            continue
        assert (code, place.where) not in AWAITING, f"{code} {place.where}: уже фраза банка"
        assert phrase["slot"] in place.slots, (
            f"{code} {place.where}: {phrase['id']} — место «{phrase['slot']}», "
            f"нужно {sorted(place.slots)}"
        )
        assert set(phrase["incidents"]) & allowed, (
            f"{code} {place.where}: {phrase['id']} — происшествия {phrase['incidents']}, "
            f"у сценария {sorted(allowed)}"
        )
        if phrase["slot"] in NEEDS_SLOTS:
            assert phrase["needs"] in place.needs, (code, place.where, phrase["needs"])
        audio = None if isinstance(place.line, str) else place.line.get("audio")
        if audio is not None:
            folder, owner, name = audio.split("/")
            assert folder.startswith("bank-v"), (code, place.where, audio)
            assert (owner, name) == (service, f"{phrase['id']}.ogg"), (code, place.where, audio)
            item = voice_manifest(folder).get(audio)
            assert item is not None, f"{code} {place.where}: {audio} нет в манифесте {folder}"
            assert item["text"] == text, (code, place.where, audio)
            path = VOICES_DIR / audio
            assert path.exists(), f"{code} {place.where}: нет файла {audio}"
            assert hashlib.sha256(path.read_bytes()).hexdigest() == item["sha256"], audio


@pytest.mark.parametrize("data", CHECKED, ids=lambda data: data["code"])
def test_bank_lines_are_voiced(data: dict[str, Any]) -> None:
    """GP-28: реплика из банка звучит записью набора bank-v<N>, а не текстом."""
    for place, phrase in bank_phrases(data):
        audio = None if isinstance(place.line, str) else place.line.get("audio")
        assert audio, f"{data['code']} {place.where}: {phrase['id']} — без записи"


def report_slot(place: Place) -> str | None:
    """Какой доклад плана звучит этой репликой: сам доклад или его подмена в ветке события."""
    if place.where.startswith("plan:"):
        return place.where.removeprefix("plan:")
    if ":replace:" in place.where:
        return place.where.rsplit(":replace:", 1)[1]
    return None


def alternatives(first: Place, second: Place) -> bool:
    """Реплики — варианты одного доклада (сам доклад и его подмены): вместе не звучат, и
    факты между ними не спорят («отказалась» в met, «госпитализируем» в missed)."""
    slot = report_slot(first)
    return slot is not None and slot == report_slot(second) and first.where != second.where


@pytest.mark.parametrize("data", CHECKED, ids=lambda data: data["code"])
def test_facts_agree_with_card_and_each_other(data: dict[str, Any]) -> None:
    """Факты фраз не спорят с карточкой и между собой; фраза в сценарии не повторяется."""
    code, card = data["code"], data["card"]
    chosen = bank_phrases(data)
    # Одна подмена доклада в нескольких ветках одного события (met и late) — не повтор.
    for first, said in chosen:
        for second, again in chosen:
            if first.where != second.where and said["id"] == again["id"]:
                assert alternatives(first, second), f"{code}: фраза повторяется: {said['id']}"
    facts = {fact: phrase["id"] for _, phrase in chosen for fact in phrase.get("facts", [])}
    card_says = {"victims" if card["victims"] else "no_victims"}
    if not card["blocked_people"]:
        card_says.add("no_blocked")
    for fact, opposite in (("victims", "no_victims"), ("blocked", "no_blocked")):
        for said, contrary in ((fact, opposite), (opposite, fact)):
            assert not (said in card_says and contrary in facts), (
                f"{code}: {facts.get(contrary)} — факт «{contrary}», а в карточке «{said}»"
            )
    for one, other in OPPOSITE:
        for first, said in chosen:
            for second, contrary in chosen:
                if one not in said.get("facts", []) or other not in contrary.get("facts", []):
                    continue
                assert alternatives(first, second), (
                    f"{code}: {said['id']} «{one}» и {contrary['id']} «{other}»"
                )
    # Реплика текстом не повторяется — правило линтера связности (`scenario_lint`), его
    # проверяет загрузчик для всех файлов каталога.


def test_awaiting_lines_are_still_missing_from_bank() -> None:
    """Список ожидающих фразы точен: каждая запись — реплика сценария, которой нет в банке."""
    by_code = {data["code"]: data for data in CHECKED}
    for (code, where), (slot, meaning) in AWAITING.items():
        assert meaning, (code, where)
        data = by_code[code]
        line = next(place.line for place in places(data) if place.where == where)
        assert line_text(line) not in BANK[data["service_id"]], (code, where)
        assert slot in {phrase["slot"] for phrase in BANK[data["service_id"]].values()}


def placement_tool() -> Any:
    """scripts/voices/bank/place.py: план фраз, ждущих записи, и как их ставить."""
    spec = importlib.util.spec_from_file_location(
        "bank_place", ROOT / "scripts" / "voices" / "bank" / "place.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_placements_fit_their_scenarios() -> None:
    """План placements.json точен: фразы ещё без записи (появилась — запустить place.py),
    каждая встаёт на своё место по правилам банка и фактам карточки (HQ-055). Пустой план —
    всё поставлено."""
    tool = placement_tool()
    items = json.loads(tool.PLAN.read_text(encoding="utf-8"))["placements"]
    recorded = tool.recordings()
    texts = tool.bank_texts()
    by_code = {data["code"]: data for data in scenario_files()}
    staged: dict[str, dict[str, Any]] = {}
    for item in items:
        phrase = item["phrase"]
        assert phrase in texts, f"{phrase}: нет в банке"
        assert phrase not in recorded, f"{phrase}: запись есть — запустить place.py"
        code = item["scenario"]
        data = staged.setdefault(code, copy.deepcopy(by_code[code]))
        assert phrase.split(".", 1)[0] == data["service_id"], (code, phrase)
        tool.place(data, item, {"text": texts[phrase]})
    for data in staged.values():
        test_every_line_is_a_bank_phrase(data)
        test_facts_agree_with_card_and_each_other(data)


def test_rules_catch_wrong_phrases() -> None:
    """Проверка ловит чужое место, чужое происшествие и спор фактов (на копии сценария)."""
    data = json.loads((SCENARIOS_DIR / "smoke-apartment-101-1.json").read_text("utf-8"))
    book = BANK["101"]
    by_id = {phrase["id"]: text for text, phrase in book.items()}
    plan = {report["key"]: report for report in data["plan"]}

    plan["arrival"]["line"] = {"text": by_id["101.completed.smoke.1"]}
    with pytest.raises(AssertionError, match="место «completed»"):
        test_every_line_is_a_bank_phrase(data)

    plan["arrival"]["line"] = {"text": by_id["101.arrived.smoke.2"]}
    plan["completion"]["line"] = {"text": by_id["101.completed.smoke.1"]}
    test_every_line_is_a_bank_phrase(data)
    gas = next(text for text, phrase in BANK["104"].items() if phrase["slot"] == "completed")
    plan["completion"]["line"] = {"text": gas}
    with pytest.raises(AssertionError, match="нет такой фразы"):
        test_every_line_is_a_bank_phrase(data)

    # «Пострадавших нет» при пострадавших в карточке.
    plan["completion"]["line"] = {"text": by_id["101.completed.smoke.2"]}
    with pytest.raises(AssertionError, match="no_victims"):
        test_facts_agree_with_card_and_each_other(data)
    # Женщина в итоге при мужчине в просьбе о скорой.
    plan["completion"]["line"] = {"text": by_id["101.completed.smoke.3"]}
    with pytest.raises(AssertionError, match="victim_male"):
        test_facts_agree_with_card_and_each_other(data)
    # Одна фраза дважды.
    plan["completion"]["line"] = {"text": by_id["101.arrived.smoke.2"]}
    with pytest.raises(AssertionError, match="повторяется"):
        test_facts_agree_with_card_and_each_other(data)


def test_briefing_asks_are_bank_phrases() -> None:
    """GP-28: бригада переспрашивает вводную фразами банка своей службы (briefing_ask)."""
    for service, phrases in briefing.ASK_AGAIN.items():
        for asks, text in phrases.items():
            phrase = BANK[service].get(text)
            assert phrase is not None, (service, asks, text)
            assert (phrase["slot"], phrase.get("asks")) == ("briefing_ask", asks), phrase["id"]
