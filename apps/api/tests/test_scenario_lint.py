"""Линтер связности сценария (`app.seed.scenario_lint`): ломаный мир не попадает в каталог.

Каждый класс несостыковок проверки 17.10 — на копии готового сценария: загрузчик называет
причину по-русски, с ключами докладов и событий. Все файлы каталога линтер проходит.
"""

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from app.api.training import caller
from app.core.config import ROOT
from app.seed.scenario_lint import lint
from app.seed.scenarios import SCENARIOS_DIR, read_file
from app.seed.world_lexicon import service_mentions, stage_conflict, stage_window

SERVICES = {item["id"] for item in json.loads((ROOT / "data/phonebook.json").read_text("utf-8"))}


def scenario(code: str = "pipe-basement-104-2") -> dict[str, Any]:
    return json.loads((SCENARIOS_DIR / f"{code}.json").read_text(encoding="utf-8"))


def event(data: dict[str, Any], key: str) -> dict[str, Any]:
    return next(item for item in data["events"] if item["key"] == key)


def report(data: dict[str, Any], key: str) -> dict[str, Any]:
    return next(item for item in data["plan"] if item["key"] == key)


@pytest.mark.parametrize("path", sorted(SCENARIOS_DIR.glob("*.json")), ids=lambda p: p.stem)
def test_catalog_scenarios_are_coherent(path: Path):
    assert lint(json.loads(path.read_text(encoding="utf-8"))) == []


def test_answer_from_the_place_to_a_question_from_the_road():
    """Проверка 17.10, случай 2: «на каком этаже?» из дороги — «Понял, поднимаемся»."""
    data = scenario()
    entrance = event(data, "entrance")
    entrance["branches"]["met"]["line"] = {"text": "Понял, поднимаемся."}
    [problem] = lint(data)
    assert "событие «entrance», ветка met" in problem
    assert "«поднимаемся»" in problem and "«enroute»" in problem


def test_turning_back_after_arrival():
    """Ответ на поправку адреса — до прибытия: «разворачиваемся» с места — противоречие."""
    data = scenario()
    event(data, "readback")["trigger"]["report"] = "arrival"
    problems = lint(data)
    assert any(
        "повтор адреса с ошибкой срабатывает только на докладе о выезде" in p for p in problems
    )
    assert any("«разворачиваемся»" in p and "«onscene»" in p for p in problems)
    assert any("последствие для доклада «arrival»" in p for p in problems)


def test_departure_report_said_twice_departing():
    """После выезда — не «выезжаем»: доклад о прибытии со словами выезда."""
    data = scenario()
    report(data, "arrival")["line"] = {"text": "Принял, выезжаем."}
    [problem] = lint(data)
    assert problem.startswith("доклад «arrival»") and "«выезжаем»" in problem


def test_service_on_scene_without_a_call():
    """Служба «на месте» в докладе, а вызвать её диспетчеру не предложено."""
    data = scenario("heart-street-103-2")
    report(data, "outcome")["line"] = {"text": "Помощь оказали, пострадавшего передали полиции."}
    [problem] = lint(data)
    assert "доклад «outcome»: служба 102 на месте" in problem


def test_called_service_never_mentioned_again():
    """Вызвал службу — бригада о ней ни слова (traffic-fire-102-2 до правки)."""
    data = scenario("traffic-fire-102-2")
    report(data, "completion")["line"] = {"text": "Работы закончили, наряд освободился."}
    problems = lint(data)
    assert any(
        "событие «firefighters»: служба 101 вызвана по просьбе бригады" in p for p in problems
    )


def test_met_answer_is_not_a_mention():
    """HQ-055: ответ ветки met не звучит — о службе бригаде сообщает диспетчер, а говорит о
    ней доклад после просьбы."""
    data = scenario("traffic-fire-102-2")
    report(data, "completion")["line"] = {"text": "Работы закончили, наряд освободился."}
    event(data, "firefighters")["branches"]["met"]["line"] = {"text": "Понял, ждём пожарных."}
    problems = lint(data)
    assert any(
        "событие «firefighters»: служба 101 вызвана по просьбе бригады" in p for p in problems
    )


def test_status_nobody_reports_is_unreachable():
    data = scenario()
    report(data, "outcome")["requires_state"] = "working"
    [problem] = lint(data)
    assert "доклад «outcome» ждёт статуса «working»" in problem


def test_event_deadline_beyond_report_pause():
    data = scenario()
    event(data, "entrance")["expect"][0]["within_s"] = 45
    [problem] = lint(data)
    assert "событие «entrance» решается через 53 с" in problem


def test_phrase_said_twice():
    data = scenario()
    entrance = event(data, "entrance")
    entrance["branches"]["met"]["line"] = copy.deepcopy(report(data, "departure")["line"])
    [problem] = lint(data)
    assert "звучит дважды" in problem


def test_caller_call_needs_live_caller():
    """HQ-019: звонок заявителю в эталоне — разговор с живым заявителем из книг банка."""
    data = scenario("animal-shaft-gkh-1")
    plot = data.pop("caller")
    [problem] = lint(data)
    assert "блока caller нет" in problem
    data["caller"] = {**plot, "plot": "no_such_plot"}
    [problem] = lint(data)
    assert "«no_such_plot»" in problem


@pytest.mark.parametrize(
    "code", ["animal-shaft-gkh-1", "pipe-access-gkh-2", "lift-location-moslift-2"]
)
def test_caller_plot_needs_every_character(monkeypatch: pytest.MonkeyPatch, code: str):
    """Сюжет есть в книге одного характера — окно телефона с другим характером отдало бы
    звонок дежурному службы: такой сюжет линтер не пропускает."""
    assert caller.caller_plots() == {"animal_shaft", "pipe_access", "lift_location"}
    calm = {pid: p for pid, p in caller.caller_phrases().items() if pid.startswith("CALLER_CALM.")}
    monkeypatch.setattr(caller, "caller_phrases", lambda: calm)
    assert caller.caller_plots() == set()
    [problem] = lint(scenario(code))
    assert "книгах обоих характеров" in problem


def test_loader_rejects_incoherent_file(tmp_path: Path):
    data = scenario()
    data["code"] = "incoherent"
    event(data, "entrance")["branches"]["met"]["line"] = {"text": "Понял, поднимаемся."}
    path = tmp_path / "incoherent.json"
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(ValueError, match="incoherent.json: событие «entrance», ветка met"):
        read_file(path, SERVICES)


@pytest.mark.parametrize(
    ("text", "stage", "bad"),
    [
        ("Диспетчер, как поняли? Улица Пришвина, семь, выезжаем!", "enroute", True),
        ("Понял поправку, разворачиваемся.", "onscene", True),
        ("Понял поправку, разворачиваемся.", "enroute", False),
        ("Понял, поднимаемся.", "enroute", True),
        ("Ладно, разберёмся на месте.", "enroute", False),
        ("Едем, на месте доложу.", "enroute", False),
        ("Только с прошлой заявки освободились, едем.", "dispatch", False),
        ("Подъезд какой? Дом длинный, не угадаем.", "onscene", False),
    ],
)
def test_stage_words(text: str, stage: str, bad: bool):
    assert (stage_conflict(text, stage) is not None) is bad, stage_window(text)


@pytest.mark.parametrize(
    ("text", "present"),
    [
        ("Пожар потушили, хозяина забрала скорая.", {"103": True}),
        ("Скорая так и не приехала, пострадавшего отвезли сами.", {"103": False}),
        ("Диспетчер, скорая едет? Женщине хуже.", {"103": False}),
        ("Женщину вывел, посадил на лавочку. Врачей пока нет.", {"103": False}),
        ("Приступ сняли. Ехать отказался, передали актив участковому врачу.", {}),
        ("Пожарные машину потушили, полосу освободили.", {"101": True}),
    ],
)
def test_service_mentions(text: str, present: dict[str, bool]):
    found = {item.ext: item.present for item in service_mentions(text, "102")}
    assert found == present
