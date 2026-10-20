"""Перенос событий не переносит чужие факты, адреса и зависимости докладов."""

from copy import deepcopy
from uuid import UUID

import pytest
from app.worker.generators import event_pool, variant_paths, variation
from app.worker.generators import gameplay as g


def template(code):
    return next(t for t in g.templates() if t["code"] == code)


def test_question_moves_to_frame_without_its_own_question_and_maps_reports():
    source = template("heart-street-103-2")
    target = deepcopy(template("traffic-blocked-103-2"))
    target["events"] = [e for e in target["events"] if e["kind"] != "clarify"]
    target["plan"][-1]["key"] = "final-report"
    question = next(e for e in source["events"] if e["kind"] == "clarify")
    original = deepcopy(question)
    moved = event_pool.transfer(question, source, target)
    assert moved and moved["key"] != question["key"]
    assert moved["branches"]["wrong"]["effects"][0]["delay"] == "final-report"
    assert moved["line"] == question["line"]
    assert question == original
    assert any(e["kind"] == "clarify" for e in event_pool.candidates(target))


@pytest.mark.parametrize("kind", ["readback_error", "request_service"])
def test_address_traps_and_service_requests_never_move(kind):
    source = template("lift-ill-moslift-2")
    event = next(e for e in source["events"] if e["kind"] == kind)
    assert event_pool.transfer(event, source, template("lift-stuck-moslift-2")) is None


def test_question_requires_card_evidence_and_same_service():
    source = template("fight-street-102-2")
    question = next(e for e in source["events"] if e["kind"] == "clarify")
    target = deepcopy(template("smoke-apartment-102-2"))
    assert event_pool.transfer(question, source, target)
    for field in g.PHONE_FIELDS:
        target["card"][field] = ""
    assert event_pool.transfer(question, source, target) is None
    assert event_pool.transfer(question, source, template("heart-street-103-2")) is None
    floor = next(e for e in template("smoke-apartment-102-2")["events"] if e["kind"] == "clarify")
    assert event_pool.transfer(floor, template("smoke-apartment-102-2"), source) is None


def test_silence_requires_state_recording_and_incident(monkeypatch):
    source = template("fight-street-102-1")
    silence = next(e for e in source["events"] if e["kind"] == "silence")
    assert event_pool.transfer(silence, source, source)
    target = template("fight-street-102-2")
    assert event_pool.transfer(silence, source, target) is None  # Нет working.
    altered = deepcopy(silence)
    altered["branches"]["met"]["line"]["text"] = "Неозвученный текст"
    assert event_pool.transfer(altered, source, source) is None
    original = g.phrase_of

    def other_incident(line):
        phrase = original(line)
        return {**phrase, "incidents": ["unrelated"]} if phrase else None

    monkeypatch.setattr(g, "incident_of", lambda _: "fight")
    monkeypatch.setattr(g, "phrase_of", other_incident)
    assert event_pool.transfer(silence, source, source) is None


def test_duplicate_donors_do_not_inflate_pool(monkeypatch):
    source = template("fight-street-102-2")
    donor = template("traffic-blocked-102-1")
    duplicate = {**deepcopy(donor), "code": "another-copy"}
    monkeypatch.setattr(g, "templates", lambda: (source, donor))
    expected = event_pool.candidates(source)
    monkeypatch.setattr(g, "templates", lambda: (source, donor, duplicate))
    assert event_pool.candidates(source) == expected


@pytest.mark.parametrize("level", [2, 3, 4])
def test_pool_variants_obey_level_and_build_checked_file(level):
    source = template("smoke-apartment-102-2")
    original = deepcopy(source)
    variants = variation.event_sets(source, level)
    pooled = [d for d in variants if any(e["key"].startswith("pool-") for e in d["events"])]
    assert pooled
    for prepared in pooled:
        assert variation.level_ok(prepared["events"], level)
        keys = [e["key"] for e in prepared["events"]]
        assert len(keys) == len(set(keys))
        spec = g.gameplay_input(
            service_id="102", level=level, seed=1, template=source, prepared=prepared
        )
        data = g.build_gameplay(
            spec,
            g.fallback_response(spec),
            scenario_id=UUID(int=1),
            origin="template",
            auto_admit=False,
        )
        g.check_file(data)
        assert "События из пула службы:" in data["teacher_comment"]
        if level == 3:
            assert all(e["kind"] not in g.HARD for e in data["events"])
    assert source == original
    assert variation.event_sets(source, 1) == variation.event_sets(source, 1, vary=False)


def test_pool_changes_signature_and_available_paths():
    available = variant_paths.options("102", 3)
    assert len(available) > 2
    source = template("fight-street-102-2")
    own = variation.select(source, 3, 0, enabled=False)
    pooled = next(
        d
        for t, d in available.values()
        if t["code"] == source["code"] and any(e["key"].startswith("pool-") for e in d["events"])
    )
    assert variant_paths.signature(own, source["code"]) != variant_paths.signature(
        pooled, source["code"]
    )


def test_pool_preserves_baseline_level_four_path():
    for service in ("101", "102", "103", "104", "GKH", "MOSLIFT"):
        for source in g.template_candidates(service, 4):
            expanded = variation.event_sets(source, 4)
            assert all(d in expanded for d in variation.event_sets(source, 4, vary=False))


def test_level_four_uses_pool_alarm_absent_from_frame():
    source = template("gas-apartment-101-2")
    assert not any(e["kind"] == "alarm" for e in source["events"])
    prepared = next(
        d
        for d in variation.event_sets(source, 4)
        if any(e["kind"] == "alarm" and e["key"].startswith("pool-") for e in d["events"])
    )
    assert variation.level_ok(prepared["events"], 4)
    g.check_file(prepared)


def test_frame_with_only_readback_becomes_available_for_higher_levels():
    source = template("traffic-blocked-102-2")
    assert {e["kind"] for e in source["events"]} == {"readback_error"}
    for level in (3, 4):
        assert source in g.template_candidates("102", level)
        for enabled in (True, False):
            data = variation.select(source, level, 1, enabled=enabled)
            assert variation.level_ok(data["events"], level)
            assert any(e["key"].startswith("pool-clarify-") for e in data["events"])
            g.check_file(data)
