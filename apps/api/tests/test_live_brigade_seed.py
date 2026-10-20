"""DT-10: события «живой бригады» в сценариях тренировки и связки — план по контракту, голос."""

import hashlib
import json
from uuid import UUID

from app.api.training.content import event_lines
from app.core.config import ROOT
from app.core.contracts import validate_json
from app.seed.link112 import LINK_DIR, load_plot
from app.seed.link112 import scenario_id as link_scenario_id
from app.seed.practice import (
    live,
    live_events,
    load_incidents,
    scenario_id,
    stages,
    training_plan,
    variants,
)

PLAN_SCHEMA = "urn:openapi#/components/schemas/TrainingPlan"
VOICES = ROOT / "data" / "voices"


def practice_plans():
    for incident in load_incidents():
        for service_id, level in variants(incident):
            variant = incident["services"][service_id]
            block = live(variant, level)
            if block is None:
                continue
            uuid = scenario_id(incident["key"], service_id, level)
            events, lines = live_events(uuid, incident["key"], service_id, block)
            plan_stages = stages(variant, level)
            plan = training_plan(
                uuid,
                service_id,
                plan_stages,
                [None] * len(plan_stages),
                events,
                block.get("after_s"),
            )
            yield incident, service_id, plan, lines


def test_practice_has_live_brigade_with_four_kinds():
    kinds = {event["kind"] for _, _, plan, _ in practice_plans() for event in plan["events"]}
    assert {"readback_error", "clarify", "request_service", "silence"} <= kinds


def test_practice_plans_follow_contract_and_links():
    for incident, _, plan, _ in practice_plans():
        validate_json(plan, PLAN_SCHEMA)
        messages = {item["message"]["id"] for item in plan["messages"]}
        event_lines(plan["events"], messages)
        # Молчание заметно, только если доклад о завершении приходит позже порога молчания;
        # и всё равно не дольше 40 с (эталон ДДС, 1.5).
        completion = plan["messages"][-1]
        silence = next(item for item in plan["events"] if item["kind"] == "silence")
        assert silence["trigger"]["silent_s"] < completion["available_after_s"] <= 40, incident[
            "key"
        ]


def test_floor_answer_is_in_card_description():
    for incident, _, plan, _ in practice_plans():
        clarify = next(item for item in plan["events"] if item["kind"] == "clarify")
        assert clarify["expect"][0]["option_key"] == "floor_9"
        assert "девятом этаже" in incident["card"]["description"]


def test_readback_repeats_a_similar_street_and_correction_is_the_card_address():
    for incident, _, plan, _ in practice_plans():
        readback = next(item for item in plan["events"] if item["kind"] == "readback_error")
        departure = plan["messages"][0]["message"]["id"]
        arrival = plan["messages"][1]["message"]["id"]
        assert readback["trigger"]["message_id"] == departure
        assert readback["review"]["critical"] is True
        address = incident["card"]["address"]
        street, house = address["street"], address["house"]
        fix = next(o for o in readback["reply_options"] if o["key"] == "fix")
        assert fix["label"] == f"Поправка по адресу: {street}, {house}"
        # Расчёт называет другую улицу, а не ту, что в карточке.
        assert street not in readback["line"]["text"]
        assert street in readback["branches"]["met"]["line"]["text"]
        # «Не так» и «не сделал» — одна подмена доклада о прибытии, одна озвучка.
        wrong, missed = (readback["branches"][key]["effects"] for key in ("wrong", "missed"))
        assert wrong == missed
        assert {effect.get("replace", effect.get("delay")) for effect in wrong} == {arrival}


def test_every_live_line_is_voiced_with_matching_text():
    manifest = {
        item["path"]: item
        for item in json.loads((VOICES / "practice/manifest.json").read_text())["messages"]
    }
    lines = [line for *_, found in practice_plans() for line in found]
    assert lines
    for line in lines:
        assert line.audio_path in manifest, line.audio_path
        assert manifest[line.audio_path]["text"] == line.message["text"]
        digest = hashlib.sha256((VOICES / line.audio_path).read_bytes()).hexdigest()
        assert digest == manifest[line.audio_path]["sha256"], line.audio_path


def test_link_plot_has_alarm_that_teacher_can_inject():
    plot = load_plot("fire_apartment_smoke", LINK_DIR)
    block = live(plot["services"]["101"], 1)
    assert block is not None
    uuid = link_scenario_id("fire_apartment_smoke.wrong-street", "101")
    events, _ = live_events(uuid, "fire_apartment_smoke.wrong-street", "101", block)
    alarm = next(item for item in events if item["kind"] == "alarm" and item["injectable"])
    assert alarm["priority"] == "alarm"
    # Критична не тревога целиком, а скорая к бойцу (решение 15.10).
    assert alarm["review"]["critical"] is False
    assert [item["action"] for item in alarm["expect"]] == ["answer_call", "call_service"]
    assert [item.get("critical", False) for item in alarm["expect"]] == [False, True]
    assert [item["weight"] for item in alarm["expect"]] == [0.1, 0.9]
    nudge = next(item for item in events if item["trigger"]["on"] == "event")
    assert UUID(nudge["trigger"]["event_id"]) == UUID(alarm["id"])
