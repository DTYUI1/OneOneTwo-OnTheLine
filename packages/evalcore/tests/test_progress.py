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


def attempt(
    minute: int,
    level: int = 1,
    passed: bool = True,
    tutorial: bool = False,
    parallel: bool = False,
    final: bool = False,
    demo: bool = False,
):
    return StepAttempt(
        level, tutorial, passed, T0 + timedelta(minutes=minute), parallel, final, demo
    )


def by_number(progress):
    return {item.number: item for item in progress}


def test_new_trainee_starts_at_step_one_and_only_it_is_open():
    progress = step_progress([])
    assert current_step(progress) == 1
    assert [item.unlocked for item in progress] == [True, False, False, False, False]
    assert len(STEPS) == 5


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


def test_parallel_shift_counts_only_for_step_four():
    """HQ-032: ступень 4 — карточки параллельной смены уровней 1–2, а не уровень сценария."""
    singles = [attempt(0, tutorial=True)] + [attempt(i) for i in range(1, 4)]
    singles += [attempt(i, level=2) for i in range(4, 7)]
    shift = [attempt(i, level=1 + i % 2, parallel=True) for i in range(7, 10)]
    progress = by_number(step_progress(singles + shift))
    assert [progress[n].attempts for n in (2, 3, 4)] == [3, 3, 3]
    assert progress[4].passed and progress[4].unlocked
    # Одиночные карточки уровней 1–2 ступень 4 не проходят, сколько бы их ни было.
    alone = by_number(step_progress(singles + [attempt(i) for i in range(7, 12)]))
    assert alone[4].attempts == 0 and not alone[4].passed
    # Карточки смены не засчитываются в ступени 2–3: ряд ступени 2 не продолжают.
    shift_card = attempt(3, parallel=True)
    mixed = by_number(
        step_progress([attempt(0, tutorial=True), attempt(1), attempt(2), shift_card])
    )
    assert (mixed[2].attempts, mixed[2].passed) == (2, False)
    # Одиночная карточка уровня 3–4 не говорит о параллельной работе.
    assert by_number(step_progress([attempt(0, level=3)]))[4].attempts == 0


def test_final_shift_counts_only_for_step_five():
    """HQ-033: ступень 5 — карточки финальной смены; в ступень 4 они не идут, и наоборот."""
    singles = [attempt(0, tutorial=True)] + [attempt(i) for i in range(1, 4)]
    singles += [attempt(i, level=2) for i in range(4, 7)]
    shift = [attempt(i, parallel=True) for i in range(7, 10)]
    final = [attempt(i, level=2, parallel=True, final=True) for i in range(10, 13)]
    progress = by_number(step_progress(singles + shift + final))
    assert [progress[n].attempts for n in (4, 5)] == [3, 3]
    assert progress[5].passed and progress[5].unlocked
    assert current_step(list(progress.values())) == 5
    # Без пройденной ступени 4 финальная смена закрыта, а её карточки ступень 4 не проходят.
    early = by_number(step_progress(singles + final))
    assert (early[4].attempts, early[4].passed) == (0, False)
    assert early[5].passed and not early[5].unlocked


def test_demo_cards_count_for_no_step():
    """HQ-034: показ курсором («Смотрю», «Как сделал бы опытный») — не попытка обучаемого."""
    watch = attempt(0, tutorial=True, demo=True)
    experts = [attempt(i, demo=True) for i in range(1, 4)]
    progress = by_number(step_progress([watch, *experts]))
    assert all(item.attempts == 0 and not item.passed for item in progress.values())
    assert current_step(list(progress.values())) == 1
    # Своя карточка после показа засчитывается как обычно.
    own = by_number(step_progress([watch, attempt(5, tutorial=True)]))
    assert (own[1].attempts, own[1].passed) == (1, True)


def test_passed_rule_matches_the_review():
    assert attempt_passed(0.8, critical=False)
    assert not attempt_passed(0.95, critical=True)
    assert not attempt_passed(0.6, critical=False)
    assert attempt_passed(0.45, critical=True, teacher_total=0.8)
