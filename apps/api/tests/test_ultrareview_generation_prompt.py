"""PR109 G07: ограничение данных модели не заменяет полный учёт разнообразия."""

import copy
import json
from itertools import product
from unittest.mock import patch

import pytest
from app.core.config import settings
from app.worker.generators import gameplay, storage


def spec_for(text_size=20):
    spec = {"template": {"plan": []}, "phrases": {}, "facts": {"reports": []}}
    for state in ("responding", "arrived", "working", "completed"):
        options = [
            {"id": f"{state}-{i}", "text": f"{state}-{i} " + "текст " * text_size} for i in range(5)
        ]
        spec["template"]["plan"].append({"justifies_state": state, "line": options[0]})
        spec["phrases"][state] = options
        spec["facts"]["reports"].append({"state": state, "options": [p["text"] for p in options]})
    return spec


def used_sets(spec):
    return [
        dict(zip(spec["phrases"], ids, strict=True))
        for ids in product(*([p["id"] for p in options] for options in spec["phrases"].values()))
    ]


def history_bytes(facts):
    return len(
        json.dumps(
            {"used_report_sets": facts.get("used_report_sets", [])},
            ensure_ascii=False,
            sort_keys=True,
        ).encode()
    )


@pytest.mark.parametrize("text_size", [1, 1000])
def test_prompt_history_is_bounded_by_count_and_serialized_bytes(text_size):
    spec = spec_for(text_size)
    used = used_sets(spec)
    before = copy.deepcopy(spec)
    with patch.object(gameplay, "phrase_of", side_effect=lambda line: line):
        result = gameplay.variety_input(spec, used * 10)
        again = gameplay.variety_input(spec, used * 10)
    assert len(result["facts"].get("used_report_sets", [])) <= storage.HISTORY_LESSONS
    # UTF-8-байты — верхняя оценка токенов истории, бюджет берётся из существующего
    # резерва generation_max_tokens; длинная фраза не обходит ограничение числа наборов.
    assert history_bytes(result["facts"]) <= settings.generation_max_tokens
    if text_size == 1:
        expected = {state: spec["phrases"][state][-1]["text"] for state in spec["phrases"]}
        assert result["facts"]["used_report_sets"][0] == expected
        assert len(
            {json.dumps(s, sort_keys=True) for s in result["facts"]["used_report_sets"]}
        ) == len(result["facts"]["used_report_sets"])
    else:
        assert not result["facts"].get("used_report_sets")
    assert spec == before and result == again


def test_prompt_history_skips_unknown_and_oversized_sets_but_keeps_recent_useful():
    spec = spec_for(1)
    useful = {state: options[0]["id"] for state, options in spec["phrases"].items()}
    unknown = {state: "неизвестный-id" * 10000 for state in spec["phrases"]}
    with patch.object(gameplay, "phrase_of", side_effect=lambda line: line):
        result = gameplay.variety_input(spec, [useful, useful, unknown])
    assert result["facts"]["used_report_sets"] == [
        {state: spec["phrases"][state][0]["text"] for state in spec["phrases"]}
    ]
    assert history_bytes(result["facts"]) <= settings.generation_max_tokens


def test_bounded_prompt_keeps_full_diversity_exclusions_and_template():
    spec = spec_for(1)
    used = used_sets(spec)
    with patch.object(gameplay, "phrase_of", side_effect=lambda line: line):
        result = gameplay.variety_input(spec, used)
    # Ограничивать можно подсказку модели, но не серверную защиту от повторов.
    assert any(
        r["text"] == spec["phrases"]["completed"][1]["text"] for r in result["facts"]["rejected"]
    )
    for report in result["facts"]["reports"]:
        state = report["state"]
        assert len(report["options"]) >= 2
        assert spec["phrases"][state][0]["text"] in report["options"]
        assert report["options"] == [p["text"] for p in result["phrases"][state]]
