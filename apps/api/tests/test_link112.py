"""Связка 112 → ДДС, шаг 1 (DT-04): карточка ДДС из записи оператора-бота.

Без БД: построитель — чистая функция над файлами `data/`, исключение из тренировки —
предикат над сценарием. Запись в БД и случайный выбор ступени проверяют интеграционные
тесты тренировки (`test_practice_scenarios.py`, `test_c04_migration.py`).
"""

import copy
import hashlib
import json
from uuid import uuid4

import pytest
from app.api.sessions.practice import practice_candidate
from app.core.config import ROOT
from app.core.contracts import validate_json
from app.core.models import Scenario
from app.operator.faults import operator_faults
from app.seed.link112 import (
    REFERENCE_ADDRESS,
    bank_records,
    build_handoff,
    delivery_events,
    link_scenario_ids,
    load_handoffs,
    load_plot,
    load_records,
    operator_scenario,
    scenario_id,
)
from app.seed.practice import expected_flow, load_incidents, training_plan, variants
from app.seed.practice import scenario_id as practice_scenario_id

RECORD_ID = "fire_apartment_smoke.wrong-street"
PHONE_EXTS = {
    item["id"]: item["phone_ext"]
    for item in json.loads((ROOT / "data/phonebook.json").read_text(encoding="utf-8"))
}
CARD_SCHEMA = "https://arm112.local/contracts/card.schema.json"
SCENARIO_SCHEMA = "https://arm112.local/contracts/scenario.schema.json"
PLAN_SCHEMA = "urn:openapi#/components/schemas/TrainingPlan"


def _record(record_id=RECORD_ID):
    return copy.deepcopy({item["id"]: item for item in load_records()}[record_id])


def _build(record):
    truth = operator_scenario(record["operator_scenario_id"])
    return build_handoff(record, truth, load_plot(truth["id"]), PHONE_EXTS)


def _correct_record():
    """Запись без ошибок: оператор записал правду сюжета."""
    truth = operator_scenario("fire_apartment_smoke")
    record = _record()
    record["card"].update(
        address=dict(truth["address"]),
        tags=list(truth["expected_tags"]),
        services=list(truth["expected_services"]),
    )
    return record


def _reference_address(address):
    """Эталон сценария ДДС — поля адреса scenario.schema.json, без подъезда, этажа, ориентира."""
    return {field: address.get(field, "") for field in REFERENCE_ADDRESS}


def _delivered(handoff, service_id="101"):
    return next(item for item in handoff.deliveries if item.service_id == service_id)


def test_handoff_from_record_matches_contract_example():
    example = json.loads(
        (ROOT / "contracts/examples/link-112-dds-handoff.json").read_text(encoding="utf-8")
    )
    [handoff] = [item for item in load_handoffs(PHONE_EXTS) if item.record_id == RECORD_ID]
    assert handoff.as_json() == example


def test_record_example_in_contract_is_the_seeded_record():
    example = json.loads(
        (ROOT / "contracts/examples/link-112-dds-record.json").read_text(encoding="utf-8")
    )
    assert example == _record()


def test_dispatcher_card_is_what_operator_entered():
    record = _record()
    handoff = _build(record)
    validate_json(handoff.card, CARD_SCHEMA)
    # Ошибка оператора доходит до службы как есть: улица — его, не правда сюжета.
    assert handoff.card["address"] == record["card"]["address"]
    assert handoff.card["address"]["street"] == "Дубининская улица"
    assert handoff.card["caller_name"] == record["card"]["caller_name"]
    assert handoff.card["service_ids"] == record["card"]["services"]
    # Одна карточка 112 — один номер для всех служб.
    numbers = {item.scenario["card"]["number"] for item in handoff.deliveries if item.scenario}
    assert numbers == {handoff.card["number"]}


def test_empty_caller_name_stays_empty_in_dispatcher_card():
    record = _record()
    record["card"]["caller_name"] = ""
    assert _build(record).card["caller_name"] == ""


def test_record_faults_are_wrong_street_and_missing_gas_service():
    faults = [fault.as_json() for fault in _build(_record()).faults]
    assert faults == [
        {
            "kind": "address",
            "effect": "wrong_place",
            "field": "street",
            "card": "Дубининская улица",
            "truth": "Дубнинская улица",
        },
        {"kind": "service_missing", "effect": "not_delivered", "service_id": "104"},
    ]


def test_faults_cover_imprecise_address_wrong_type_and_extra_service():
    truth = operator_scenario("fire_apartment_smoke")
    address = {**truth["address"], "apartment": "74"}
    faults = operator_faults(
        truth,
        incident_type_code="1010101",
        services=[*truth["expected_services"], "GKH"],
        address=address,
    )
    assert [(fault.kind, fault.effect) for fault in faults] == [
        ("address", "imprecise"),
        ("incident_type", "wrong_type"),
        ("service_extra", "extra_dispatch"),
    ]


def test_service_101_gets_scenario_with_wrong_address_plan():
    handoff = _build(_record())
    delivery = _delivered(handoff)
    assert delivery.status == "delivered"
    payload = delivery.scenario
    validate_json(payload, SCENARIO_SCHEMA)
    truth = operator_scenario("fire_apartment_smoke")
    assert payload["card"] == handoff.card
    assert payload["complications"] == ["wrong_address"]
    # Бригада назвала уточнённый адрес — диспетчер его знает и пишет в комментарий.
    assert payload["reference"]["expected_address"] == _reference_address(truth["address"])
    arrival = next(stage for stage in delivery.stages if stage.name == "arrival")
    assert "Дубининская улица, дом 12" in arrival.text
    assert "Дубнинская улица, дом 12" in arrival.text
    assert arrival.justifies == "arrived"
    assert "оператора-бота" in payload["teacher_comment"]


def test_correct_record_has_no_faults_and_truth_plan():
    handoff = _build(_correct_record())
    assert handoff.faults == ()
    delivery = _delivered(handoff)
    assert delivery.scenario["complications"] == []
    assert delivery.scenario["reference"]["expected_address"] == _reference_address(
        handoff.card["address"]
    )
    plot = load_plot("fire_apartment_smoke")["services"]["101"]
    assert [stage.text for stage in delivery.stages] == [
        plot["departure"],
        *plot["full"].values(),
    ]


def test_deliveries_follow_card_services():
    statuses = {item.service_id: item.status for item in _build(_record()).deliveries}
    # 104 оператор не выбрал; у 102, 103, MOSLIFT в сюжете пока нет докладов (одна служба к демо).
    assert statuses == {
        "101": "delivered",
        "102": "no_plot",
        "103": "no_plot",
        "MOSLIFT": "no_plot",
        "104": "not_delivered",
    }


def test_reports_wait_for_dispatcher_status_and_justify_reference_flow():
    for record in (_record(), _correct_record()):
        delivery = _delivered(_build(record))
        flow = delivery.scenario["reference"]["expected_flow"]
        variant = load_plot("fire_apartment_smoke")["services"]["101"]
        assert flow == expected_flow(variant, record["level"])
        after_decision = flow[flow.index("accepted") + 1 :]
        assert [stage.justifies for stage in delivery.stages] == after_decision
        assert [stage.requires for stage in delivery.stages] == [
            "accepted",
            *after_decision[:-1],
        ]
        plan = training_plan(
            scenario_id(record["id"], "101"),
            "101",
            list(delivery.stages),
            [None] * len(delivery.stages),
        )
        validate_json(plan, PLAN_SCHEMA)


def test_wrong_place_without_report_for_it_is_an_error():
    record = _record()
    truth = operator_scenario(record["operator_scenario_id"])
    plot = copy.deepcopy(load_plot(truth["id"]))
    del plot["services"]["101"]["wrong_address"]
    with pytest.raises(ValueError, match="уводит бригаду"):
        build_handoff(record, truth, plot, PHONE_EXTS)


def test_scenario_ids_are_stable():
    first = _delivered(_build(_record())).scenario["id"]
    second = _delivered(_build(_record())).scenario["id"]
    assert first == second == str(scenario_id(RECORD_ID, "101"))


def test_link_scenarios_are_not_in_practice_pool():
    link = Scenario(id=scenario_id(RECORD_ID, "101"), target_service_id="101")
    assert link.id in link_scenario_ids()
    assert not practice_candidate(link)
    incident = load_incidents()[0]
    service_id, level = variants(incident)[0]
    practice = Scenario(
        id=practice_scenario_id(incident["key"], service_id, level), target_service_id=service_id
    )
    assert practice_candidate(practice)
    assert practice_candidate(Scenario(id=uuid4(), target_service_id="101"))


def _link_lines():
    """Все реплики сценариев связки: (служба, текст) докладов плана и реплик событий."""
    found = []
    for handoff in load_handoffs(PHONE_EXTS):
        for delivery in handoff.deliveries:
            if delivery.scenario is None:
                continue
            _, lines, _ = delivery_events(handoff, delivery)
            found += [(delivery.service_id, stage.text) for stage in delivery.stages]
            found += [(delivery.service_id, line.message["text"]) for line in lines]
    return found


def test_every_link_report_and_live_line_is_a_bank_phrase():
    """Голос связки — записи банка, не Piper (проверка 17.10). Каждая реплика — дословно фраза
    книги службы или scripts/voices/bank/link112: после синтеза её запишет банк, и seed
    возьмёт запись по службе и тексту. Реплика без звука засчитывается только кнопкой
    «Принял» (DT-12), поэтому фразы для неё нужны все."""
    bank_dir = ROOT / "scripts" / "voices" / "bank"
    phrases = {
        (book["service"], phrase["text"])
        for folder in ("phrases", "addresses", "link112")
        for path in sorted((bank_dir / folder).glob("*.json"))
        for book in [json.loads(path.read_text(encoding="utf-8"))]
        for phrase in book["phrases"]
    }
    lines = _link_lines()
    # Сюжет записи: доклады 101 обоих уровней, прибытие не туда и пять реплик тревоги.
    assert len(set(lines)) >= 10
    assert any(text.startswith("Расчёт прибыл по адресу из карточки") for _, text in lines)
    assert [line for line in lines if line not in phrases] == []


def test_every_link_line_is_recorded_by_brigade_voice():
    """Каждая реплика связки записана в наборах bank-v* (HQ-036, bank-v7) голосом бригады своей
    службы (scripts/voices/casting/voices.json): в seed ни одна не уходит текстом, у абонента
    один голос. Файл записи совпадает с манифестом."""
    voices = ROOT / "data" / "voices"
    bank = bank_records(voices)
    cast = json.loads((ROOT / "scripts/voices/casting/voices.json").read_text(encoding="utf-8"))[
        "voices"
    ]
    lines = sorted(set(_link_lines()))
    assert [line for line in lines if line not in bank] == []
    for service_id, text in lines:
        item = bank[(service_id, text)]
        assert item["path"].startswith("bank-v"), item["path"]
        assert cast[service_id]["voice_id"] in item["voice"], (item["path"], item["voice"])
        digest = hashlib.sha256((voices / item["path"]).read_bytes()).hexdigest()
        assert digest == item["sha256"], item["path"]


def test_bank_records_prefer_newest_set(tmp_path):
    """Один текст в двух наборах — запись самого нового (bank-v10 новее bank-v9)."""
    for version in (9, 10):
        folder = tmp_path / f"bank-v{version}"
        folder.mkdir()
        item = {"service_id": "101", "text": "Принял.", "path": f"bank-v{version}/101/a.ogg"}
        (folder / "manifest.json").write_text(json.dumps({"messages": [item]}), encoding="utf-8")
    assert bank_records(tmp_path)[("101", "Принял.")]["path"] == "bank-v10/101/a.ogg"
