"""Ступени обучения: условия прохождения и открытия."""

from datetime import UTC, datetime, timedelta

from evalcore.progress import (
    STEPS,
    StepAttempt,
    attempt_passed,
    current_step,
    step_progress,
)

T0 = datetime(2026, 9, 29, 10, tzinfo=UTC)


def attempt(minute: int, level: int = 1, passed: bool = True, tutorial: bool = False):
    return StepAttempt(level, tutorial, passed, T0 + timedelta(minutes=minute))


def by_number(progress):
    return {item.number: item for item in progress}


def test_new_trainee_starts_at_step_one_and_only_it_is_open():
    progress = step_progress([])
    assert current_step(progress) == 1
    assert [item.unlocked for item in progress] == [True, False, False, False]
    assert len(STEPS) == 4


def test_tutorial_opens_step_two_and_three_in_a_row_open_step_three():
    progress = by_number(
        step_progress(
            [
                attempt(0, tutorial=True),
                attempt(1),
                attempt(2),
                attempt(3, passed=False),
                attempt(4),
                attempt(5),
            ]
        )
    )
    assert progress[1].passed and progress[2].unlocked
    # Ряд прервался ошибкой: 2 подряд из 3 — ступень 2 ещё не пройдена.
    assert (progress[2].streak, progress[2].passed) == (2, False)
    assert not progress[3].unlocked


def test_passed_step_stays_passed_after_a_later_failure():
    progress = by_number(
        step_progress(
            [
                attempt(0, tutorial=True),
                attempt(1),
                attempt(2),
                attempt(3),
                attempt(4, passed=False),
            ]
        )
    )
    assert progress[2].passed and progress[2].streak == 0
    assert progress[3].unlocked
    assert current_step(list(progress.values())) == 3


def test_levels_count_for_their_step_only():
    progress = by_number(
        step_progress([attempt(0, tutorial=True)] + [attempt(i, level=2) for i in range(1, 4)])
    )
    # Уровень 2 — ступень 3; ступень 2 (уровень 1) не пройдена, поэтому 3 ещё закрыта.
    assert progress[3].passed and not progress[3].unlocked
    assert progress[2].attempts == 0


def test_passed_rule_matches_the_review():
    assert attempt_passed(0.8, critical=False)
    assert not attempt_passed(0.95, critical=True)
    assert not attempt_passed(0.6, critical=False)
    assert attempt_passed(0.45, critical=True, teacher_total=0.8)
