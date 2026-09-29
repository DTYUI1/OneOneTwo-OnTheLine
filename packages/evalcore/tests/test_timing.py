"""calculate_timing совпадает со всеми общими примерами I-TIME v1/v2/v3 (как shared/timing.ts)."""

import json
from dataclasses import asdict, replace
from pathlib import Path

import pytest
from evalcore.timing import calculate_timing
from evalcore.timing_contract import TimingInput
from pydantic import TypeAdapter

ROOT = Path(__file__).resolve().parents[3]
CASES = [
    case
    for name in ("timing-v2.json", "timing-v3.json")
    for case in json.loads((ROOT / "contracts/examples" / name).read_text(encoding="utf-8"))
]


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_shared_fixture(case):
    value = TypeAdapter(TimingInput).validate_python(case["input"])
    assert asdict(calculate_timing(value)) == case["expected"]


def test_deterministic_and_submillisecond_server_time_is_truncated():
    value = TypeAdapter(TimingInput).validate_python(CASES[0]["input"])
    assert calculate_timing(value) == calculate_timing(value)
    # Серверное время PostgreSQL с микросекундами даёт те же числа, что Date.parse в браузере.
    events = [replace(e, server_ts=e.server_ts.replace(".000Z", ".000999Z")) for e in value.events]
    assert calculate_timing(replace(value, events=events)).reaction_s == 20
