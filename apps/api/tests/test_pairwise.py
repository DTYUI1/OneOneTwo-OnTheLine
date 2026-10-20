"""Жадное покрытие достижимых пар, история и воспроизводимость пакета."""

import random
from collections import Counter
from itertools import product
from types import SimpleNamespace

from app.worker.generators import pairwise, variant_paths


def variant(readback, question, other, contact, outcome):
    events = []
    for kind, stage in (
        ("readback_error", "responding" if readback else None),
        ("clarify", question),
        ("request_service", "arrived" if other else None),
        ("silence", contact),
    ):
        if stage:
            events.append({"key": kind, "kind": kind, "trigger": {"on": "state", "state": stage}})
    return {
        "events": events,
        "plan": [],
        "reference": {"expected_flow": ["responding", "arrived", "working", outcome]},
    }


def synthetic():
    return {
        str(i): ({"code": str(i)}, variant(*values))
        for i, values in enumerate(
            product(
                (False, True),
                (None, "responding", "arrived"),
                (False, True),
                (None, "arrived", "working"),
                ("completed", "refused"),
            )
        )
    }


def batch(available, seed, count, profile=None):
    counts, templates = Counter(), Counter()
    covered, chosen = set(), []
    for index in range(count):
        source, data = variant_paths.pick(
            "102",
            2,
            seed + index,
            counts,
            templates,
            covered_pairs=covered,
            profile=profile,
            focus=True,
        )
        key = source["code"]
        counts[key] += 1
        templates[key] += 1
        covered.update(pairwise.pairs(pairwise.features(data)))
        chosen.append(key)
    return chosen


def coverage_length(available, order):
    possible, covered = pairwise.universe(available), set()
    for index, key in enumerate(order, 1):
        covered.update(pairwise.pairs(pairwise.features(available[key][1])))
        if covered == possible:
            return index
    raise AssertionError("Не покрыты все пары")


def test_greedy_covers_pairs_earlier_than_random_and_repeats_after_exhaustion(monkeypatch):
    available = synthetic()
    monkeypatch.setattr(variant_paths, "options", lambda *_: available)
    chosen = batch(available, 42, len(available) * 2)
    random_order = list(available)
    random.Random(42).shuffle(random_order)
    assert coverage_length(available, chosen) < coverage_length(available, random_order)
    assert len(set(chosen[: len(available)])) == len(available)
    assert set(Counter(chosen).values()) == {2}
    assert chosen == batch(available, 42, len(available) * 2)
    monkeypatch.setattr(variant_paths, "options", lambda *_: dict(reversed(available.items())))
    assert chosen == batch(available, 42, len(available) * 2)
    profile = {"readback_error": {"rate": 1}}
    assert batch(available, 42, 20, profile) == batch(available, 42, 20, profile)


def test_gain_precedes_history_and_weakness_but_history_breaks_ties(monkeypatch):
    available = synthetic()
    monkeypatch.setattr(variant_paths, "options", lambda *_: available)
    covered = pairwise.pairs(pairwise.features(available["0"][1]))
    gains = {
        key: len(pairwise.pairs(pairwise.features(data)) - covered)
        for key, (_, data) in available.items()
    }
    best = max(gains.values())
    winners = [key for key in available if gains[key] == best]
    preferred = winners[-1]
    counts = Counter(dict.fromkeys(winners, 100))
    counts[preferred] = 99
    source, _ = variant_paths.pick(
        "102",
        2,
        1,
        counts,
        Counter(),
        covered_pairs=covered,
        profile={"readback_error": {"rate": 1}},
        focus=True,
    )
    assert source["code"] == preferred


def test_features_resolve_report_and_injected_stages_ignore_cosmetics():
    data = variant(True, "responding", True, "working", "refused")
    data["plan"] = [{"key": "departure", "justifies_state": "responding"}]
    data["events"][1]["trigger"] = {"on": "message", "report": "departure", "after_s": 8}
    data["events"][-1] = {
        "key": "alarm",
        "kind": "alarm",
        "trigger": {"on": "inject", "requires_state": "working"},
    }
    expected = {
        "readback": ["yes"],
        "question": ["responding"],
        "other_service": ["yes"],
        "contact": ["working"],
        "outcome": ["refused"],
    }
    assert pairwise.features(data) == expected
    rows = [SimpleNamespace(generation_metadata={"constructor": {"pairwise_features": expected}})]
    assert pairwise.covered(rows * 2) == pairwise.pairs(expected)
    data["events"][1]["trigger"] = {"on": "state", "state": "arrived"}
    assert pairwise.features(data)["question"] == ["on_scene"]


def test_resume_old_metadata_and_filtered_universe(monkeypatch):
    available = synthetic()
    # Только одна разрешённая тема: недостижимые пары не входят в знаменатель.
    allowed = {"0": available["0"]}
    monkeypatch.setattr(variant_paths, "options", lambda *_: allowed)
    old = SimpleNamespace(
        target_service_id="102",
        level=2,
        generation_metadata={"constructor": {"variant_signature": "0"}},
    )
    assert pairwise.covered([old]) == pairwise.universe(allowed)
    assert len(pairwise.universe(allowed)) == 10
    assert pairwise.universe(allowed) < pairwise.universe(available)


def test_two_stages_cover_both_values_without_pairs_within_one_feature():
    data = variant(False, "responding", False, "arrived", "completed")
    data["events"].append(
        {
            "key": "alarm",
            "kind": "alarm",
            "trigger": {"on": "inject", "requires_state": "working"},
        }
    )
    values = pairwise.features(data)
    assert values["contact"] == ["arrived", "working"]
    pairs = pairwise.pairs(values)
    assert (("contact", "arrived"), ("question", "responding")) in pairs
    assert (("contact", "working"), ("question", "responding")) in pairs
    assert all(left[0] != right[0] for left, right in pairs)
    assert len(pairs) == 14
