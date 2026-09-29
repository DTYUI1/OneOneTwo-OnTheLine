from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest
from evalcore.adaptive import recommend_level
from evalcore.iteration_contract import CalibrationObservation


def observation(
    index: int,
    *,
    score: float,
    handling_s: float | None = 100,
    normative_s: float | None = 180,
    quality: str | None = "verified",
    level: int = 2,
    weight: int = 4,
) -> CalibrationObservation:
    made_at = datetime(2026, 9, 25, tzinfo=UTC) + timedelta(minutes=index)
    return CalibrationObservation(
        card_id=f"card-{index}",
        prediction_id=f"prediction-{index}",
        made_at=made_at.isoformat(),
        completed_at=(made_at + timedelta(seconds=200)).isoformat(),
        predicted_score=0.7,
        automatic_score=score,
        effective_score=score,
        override_id=None,
        handling_s=handling_s,
        timing_version=2,
        snapshot_id=f"snapshot-{index}",
        handling_normative_s=normative_s,
        timing_quality=quality,  # type: ignore[arg-type]
        level=level,
        weight=weight,
    )


@pytest.mark.parametrize("count", [0, 1, 2])
def test_cold_start_keeps_level_and_explains_limited_history(count):
    history = [observation(index, score=1) for index in range(count)]

    result = recommend_level(2, history, critical_flags_by_card={})

    assert result.level == 2
    assert result.direction == "keep"
    assert result.based_on_attempts == count
    assert "Холодный старт" in result.evidence[0]
    assert "Холодный старт" in result.explanation


def test_high_scores_without_critical_or_timing_errors_increase_one_step():
    history = [observation(index, score=score) for index, score in enumerate((0.8, 0.9, 1.0))]

    result = recommend_level(2, history, critical_flags_by_card={})

    assert (result.level, result.weight, result.direction) == (3, 5, "increase")
    assert "Средний итоговый балл: 0.90." in result.evidence
    assert "Норматив времени соблюдён в 3 из 3 измерений." in result.evidence


def test_one_critical_attempt_blocks_increase_without_forcing_decrease():
    history = [observation(index, score=0.9) for index in range(3)]

    result = recommend_level(2, history, critical_flags_by_card={"card-2": ["address"]})

    assert (result.level, result.weight, result.direction) == (2, 4, "keep")
    assert "Попыток с критическими ошибками: 1." in result.evidence


@pytest.mark.parametrize(
    "history,flags",
    [
        ([observation(index, score=0.5) for index in range(3)], {}),
        (
            [observation(index, score=0.9) for index in range(3)],
            {"card-0": ["routing"], "card-1": ["address"]},
        ),
        ([observation(index, score=0.8, handling_s=200) for index in range(3)], {}),
    ],
)
def test_repeated_low_score_critical_or_overdue_results_decrease(history, flags):
    result = recommend_level(2, history, critical_flags_by_card=flags)

    assert (result.level, result.weight, result.direction) == (1, 3, "decrease")


def test_unverified_time_is_reported_as_unknown_not_as_timeout():
    history = [
        observation(index, score=0.9, handling_s=300, quality="estimated") for index in range(3)
    ]

    result = recommend_level(2, history, critical_flags_by_card={})

    assert result.direction == "increase"
    assert "Подтверждённых сопоставимых измерений времени нет." in result.evidence


def test_only_five_latest_attempts_are_used_in_chronological_order():
    old = [observation(index, score=0.1) for index in range(2)]
    recent = [observation(index + 2, score=0.9, weight=6) for index in range(5)]

    result = recommend_level(3, [*recent, *old], critical_flags_by_card={})

    assert result.based_on_attempts == 5
    assert (result.level, result.weight, result.direction) == (4, 7, "increase")


def test_teacher_effective_score_is_used_instead_of_automatic_score():
    history = [
        replace(observation(index, score=0.9), automatic_score=0.2, override_id=f"override-{index}")
        for index in range(3)
    ]

    assert recommend_level(2, history, critical_flags_by_card={}).direction == "increase"


def test_missing_critical_evidence_does_not_claim_zero_or_increase():
    history = [observation(index, score=0.9) for index in range(3)]

    result = recommend_level(2, history)

    assert result.direction == "keep"
    assert "Сведения о критических ошибках не переданы." in result.evidence


@pytest.mark.parametrize(
    ("level", "weight", "score"),
    [(4, 10, 0.9), (1, 1, 0.4)],
)
def test_level_and_weight_boundaries_do_not_claim_impossible_change(level, weight, score):
    history = [observation(index, score=score, level=level, weight=weight) for index in range(3)]

    result = recommend_level(level, history, critical_flags_by_card={})

    assert (result.level, result.weight, result.direction) == (level, weight, "keep")


def test_invalid_score_and_verified_time_are_rejected():
    with pytest.raises(ValueError, match="effective_score"):
        recommend_level(
            2,
            [
                replace(observation(index, score=0.9), effective_score=float("nan"))
                for index in range(3)
            ],
            critical_flags_by_card={},
        )
    with pytest.raises(ValueError, match="handling_s"):
        recommend_level(
            2,
            [observation(index, score=0.9, handling_s=-1) for index in range(3)],
            critical_flags_by_card={},
        )


@pytest.mark.parametrize("level", [0, 5, True, 2.5])
def test_invalid_current_level_is_rejected(level):
    with pytest.raises(ValueError, match="current_level"):
        recommend_level(level, [])
