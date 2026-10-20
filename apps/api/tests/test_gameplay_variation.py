"""Вариация меняет учебные действия, оставаясь воспроизводимой и допустимой для уровня."""

import json
from copy import deepcopy
from uuid import UUID

import pytest
from app.worker.generators import gameplay as g
from app.worker.generators import variation


def source(code):
    return next(t for t in g.templates() if t["code"] == code)


def build(template, level, seed, scenario_id=None, vary=True):
    spec = g.gameplay_input(
        service_id=template["service_id"], level=level, seed=seed, template=template, vary=vary
    )
    data = g.build_gameplay(
        spec,
        g.fallback_response(spec),
        scenario_id=scenario_id or UUID(int=1),
        origin="llm",
        auto_admit=False,
    )
    g.check_file(data)
    return spec, data


@pytest.mark.parametrize("level", [2, 3, 4])
def test_ten_seeds_change_actions_on_one_template(level):
    template = source("fight-street-102-2")
    original = deepcopy(template)
    signatures = set()
    sizes = set()
    for seed in range(10):
        spec, data = build(template, level, seed)
        metadata = variation.describe(data, template)
        assert metadata == spec["variation"]
        # Именно триггеры и конечный статус, а не текст докладов или порядок JSON.
        actions = sorted(json.dumps(e, sort_keys=True) for e in metadata["events"])
        signatures.add((tuple(actions), metadata["terminal_state"]))
        sizes.add(len(data["events"]))
        assert variation.level_ok(data["events"], level)
        if any(e["kind"] == "readback_error" for e in data["events"]):
            assert data["card"]["address"] == template["card"]["address"]
        assert data["reference"]["expected_address"] == data["card"]["address"]
        _, again = build(template, level, seed, UUID(int=200))
        assert variation.describe(again, template) == metadata
        assert again["events"] == data["events"]
    assert len(signatures) >= 3
    if level == 2:
        assert sizes == {1, 2}
    assert template == original


def test_question_can_move_after_arrival_and_delay_the_following_report():
    template = source("pipe-flat-gkh-2")
    variants = [build(template, 3, seed)[1] for seed in range(10)]
    questions = [next(e for e in d["events"] if e["kind"] == "clarify") for d in variants]
    assert {e["trigger"]["report"] for e in questions} == {"departure", "arrival"}
    for e in questions:
        target = "arrival" if e["trigger"]["report"] == "departure" else "works"
        assert e["branches"]["missed"]["effects"][0]["delay"] == target


def test_outcome_changes_only_as_a_consistent_recorded_plan():
    template = source("smoke-apartment-101-2")
    results = [build(template, 3, seed)[1] for seed in range(10)]
    assert {d["plan"][-1]["justifies_state"] for d in results} == {"completed", "refused"}
    for data in results:
        terminal = data["plan"][-1]
        assert data["reference"]["expected_flow"][-1] == terminal["justifies_state"]
        assert terminal["line"]["text"] in data["outcome"]["people"]
        assert terminal["line"]["text"] in data["reference"]["expected_comment"]
        assert (g.VOICES / terminal["line"]["audio"]).is_file()
    # Для отопления нет каталожного образца отказа ЖКХ: даже записанный refused не годится.
    heat = source("heating-gkh-2")
    assert all(
        build(heat, 3, seed)[1]["plan"][-1]["justifies_state"] == "completed" for seed in range(10)
    )


def test_invalid_variation_returns_to_baseline(monkeypatch):
    template = source("fight-street-102-2")
    baseline = variation.select(template, 3, 7, enabled=False)

    def broken(data, rng, level):
        result = deepcopy(data)
        result["events"][0]["trigger"]["report"] = "missing-report"
        return result

    monkeypatch.setattr(variation, "retime", broken)
    assert variation.select(template, 3, 7) == baseline


def test_outcome_cannot_leave_a_refusal_in_completed_branch():
    template = source("lift-stuck-moslift-2")
    base = variation.select(template, 3, 0, enabled=False)
    assert len(variation.outcome_options(base, 3)) == 1


@pytest.mark.parametrize("conflicting_unchanged_report", [False, True])
def test_branch_replaces_two_reports_together(monkeypatch, conflicting_unchanged_report):
    from app.worker.generators.validation import GenerationRejected

    template = deepcopy(source("lift-stuck-103-1"))
    branch = next(e for e in template["events"] if e["key"] == "rescue")["branches"]["missed"]
    swaps = [effect for effect in branch["effects"] if "replace" in effect]
    assert {effect["replace"] for effect in swaps} == {"works", "completion"}
    # Усиливаем факты реального каркаса: оба исходных доклада говорят об отказе,
    # оба заменяющих — о госпитализации. Смешивать половины этих исходов нельзя.
    facts = {
        report["line"]["text"]: ["victims", "refused_hospital"]
        for report in template["plan"]
        if report["key"] in {"works", "completion"}
        or (conflicting_unchanged_report and report["key"] == "arrival")
    }
    facts.update({effect["with"]["text"]: ["victims", "hospitalized"] for effect in swaps})
    original_phrase_of = g.phrase_of

    def phrase_of(line):
        phrase = original_phrase_of(line)
        if phrase and phrase["text"] in facts:
            return {**phrase, "facts": facts[phrase["text"]]}
        return phrase

    monkeypatch.setattr(g, "phrase_of", phrase_of)
    spec = g.gameplay_input(service_id="103", level=1, seed=0, template=template, prepared=template)
    response = g.fallback_response(spec)
    if conflicting_unchanged_report:
        with pytest.raises(GenerationRejected):
            g.chosen_phrases(spec, response)
        assert not variation.checked(template, 1)
    else:
        assert len(g.chosen_phrases(spec, response)) == len(template["plan"])
        assert variation.checked(template, 1)
