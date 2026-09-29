"""Представимость входов V-03; вероятности нового алгоритма здесь не вычисляются."""

import json
import math
from dataclasses import FrozenInstanceError, asdict
from pathlib import Path

import pytest
from evalcore.adaptive import predict
from evalcore.iteration_contract import CalibrationObservation, PredictionContext
from evalcore.models import Trainee
from evalcore.timing_contract import TimingPolicy

ROOT = Path(__file__).resolve().parents[3]
DEFINITIONS = json.loads((ROOT / "contracts/c01.schema.json").read_text(encoding="utf-8"))["$defs"]


def contexts():
    return [
        PredictionContext(
            contract_version=value["contract_version"],
            snapshot_id=value["snapshot_id"],
            policy=TimingPolicy(**value["policy"]),
        )
        for value in DEFINITIONS["PredictionContext"]["examples"]
    ]


def test_same_trainee_and_scenario_have_distinct_snapshot_thresholds():
    trainee = Trainee(theta=0.5, log_time_mean=math.log(120), log_time_variance=0.25)
    scenario = json.loads(
        (ROOT / "data/golden_scenarios/case-01.json").read_text(encoding="utf-8")
    )["scenario"]
    first, second = contexts()
    inputs = [(trainee, scenario, first), (trainee, scenario, second)]
    assert inputs[0][:2] == inputs[1][:2]
    assert first.snapshot_id != second.snapshot_id
    assert first.policy.handling_normative_s == 100
    assert second.policy.handling_normative_s == 180
    assert first.policy.timing_version == second.policy.timing_version == 2
    assert trainee.log_time_mean == math.log(120)
    with pytest.raises(FrozenInstanceError):
        first.policy.handling_normative_s = 180


def test_history_keeps_its_own_normative_and_explicit_unknowns():
    first, second = contexts()
    history = [
        CalibrationObservation(**value)
        for value in DEFINITIONS["CalibrationObservation"]["examples"]
    ]
    verified, estimated, unknown = history
    assert verified.snapshot_id == first.snapshot_id
    assert verified.handling_normative_s == first.policy.handling_normative_s == 100
    assert estimated.snapshot_id == second.snapshot_id
    assert estimated.handling_normative_s == second.policy.handling_normative_s == 180
    assert verified.handling_s == estimated.handling_s == 170
    assert verified.timing_quality == "verified"
    assert estimated.timing_quality == "estimated"
    assert unknown.timing_version == 1
    for field in ["snapshot_id", "handling_s", "handling_normative_s", "timing_quality"]:
        assert asdict(unknown)[field] is None


def test_legacy_predict_keeps_two_argument_call_and_explicit_stub():
    with pytest.raises(NotImplementedError, match="T-022"):
        predict(Trainee(theta=0, log_time_mean=math.log(180), log_time_variance=0.25), {})
