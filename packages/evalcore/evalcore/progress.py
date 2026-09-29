"""Ступени обучения (29.09): путь обучаемого от интерфейса до параллельной работы.

Как стажировка операторов 112 (EENA: SOS Alarm, модель Сан-Хосе APCO) — навыки по
возрастанию, у каждой ступени понятное условие. Ступень пройдена, если был ряд из
`required` подряд зачтённых попыток её уровня; пройденная не «слетает» от поздней ошибки.
Следующая открывается после предыдущей. Засчитываются карточки и занятий преподавателя,
и самостоятельных тренировок. Уровень занятия по-прежнему ставит преподаватель: ступени
только открывают тренировку и подсказывают.

Зачтено — как в разборе у обучаемого: без критической ошибки и от 70 %; новый балл
преподавателя главнее.
"""

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime

PASS_TOTAL = 0.7


@dataclass(frozen=True)
class Step:
    number: int
    title: str
    skill: str
    levels: tuple[int, ...]
    required: int
    tutorial: bool = False
    # Одновременных карточек в тренировке этой ступени.
    parallel: int = 1


STEPS: tuple[Step, ...] = (
    Step(1, "Интерфейс и статусы", "Карточка от начала до конца с подсказчиком", (1,), 1, True),
    Step(2, "Своя карточка", "Принять, отметить этапы, доложить, завершить", (1,), 3),
    Step(3, "Сложные карточки", "Отказ, перенаправление, осложнения", (2,), 3),
    Step(4, "Параллельная работа", "Две карточки одновременно", (3, 4), 3, parallel=2),
)


@dataclass(frozen=True)
class StepAttempt:
    """Закрытая и оценённая карточка обучаемого."""

    level: int
    tutorial: bool
    passed: bool
    at: datetime


@dataclass(frozen=True)
class StepProgress:
    number: int
    title: str
    skill: str
    required: int
    attempts: int
    streak: int
    passed: bool
    unlocked: bool


def attempt_passed(total: float, critical: bool, teacher_total: float | None = None) -> bool:
    """Зачтено: новый балл преподавателя главнее; иначе без критической ошибки и от 70 %."""
    if teacher_total is not None:
        return teacher_total >= PASS_TOTAL
    return not critical and total >= PASS_TOTAL


def belongs(step: Step, attempt: StepAttempt) -> bool:
    if step.tutorial:
        return attempt.tutorial
    return not attempt.tutorial and attempt.level in step.levels


def step_progress(attempts: Iterable[StepAttempt]) -> list[StepProgress]:
    ordered = sorted(attempts, key=lambda item: item.at)
    result: list[StepProgress] = []
    previous_passed = True
    for step in STEPS:
        own = [item for item in ordered if belongs(step, item)]
        best = run = 0
        for item in own:
            run = run + 1 if item.passed else 0
            best = max(best, run)
        passed = best >= step.required
        result.append(
            StepProgress(
                number=step.number,
                title=step.title,
                skill=step.skill,
                required=step.required,
                attempts=len(own),
                # Текущий ряд подряд (для «ещё N до ступени»), не больше нужного.
                streak=min(run, step.required),
                passed=passed,
                unlocked=previous_passed,
            )
        )
        previous_passed = passed
    return result


def current_step(progress: list[StepProgress]) -> int:
    """Первая непройденная ступень; всё пройдено — последняя."""
    for item in progress:
        if not item.passed:
            return item.number
    return progress[-1].number


def step_by_number(number: int) -> Step:
    for step in STEPS:
        if step.number == number:
            return step
    raise ValueError(f"Нет ступени {number}")
