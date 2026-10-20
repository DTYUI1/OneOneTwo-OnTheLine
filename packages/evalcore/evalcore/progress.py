"""Ступени обучения (29.09): путь обучаемого от интерфейса до параллельной работы.

Как стажировка операторов 112 (EENA: SOS Alarm, модель Сан-Хосе APCO) — навыки по
возрастанию, у каждой ступени понятное условие. Ступень пройдена, если был ряд из
`required` подряд зачтённых попыток её уровня; пройденная не «слетает» от поздней ошибки.
Следующая открывается после предыдущей. Засчитываются карточки и занятий преподавателя,
и самостоятельных тренировок. Уровень занятия по-прежнему ставит преподаватель: ступени
только открывают тренировку и подсказывают.

Зачтено — как в разборе у обучаемого: без критической ошибки и от 70 %; новый балл
преподавателя главнее.

Ступень 4 (HQ-032) — параллельная смена: две проработанные карточки уровней 1–2 своей
службы, вторая приходит, пока идёт первая. Попытка ступени 4 — карточка такой смены
(`StepAttempt.parallel`), а не карточка уровня 3–4: сценариев параллельной работы своих нет,
а уровень сценария не говорит, шла ли карточка одна. Поэтому одиночные карточки уровней 1–2
идут в ступени 2–3, а карточки параллельной смены — только в ступень 4, какого бы уровня ни
был их сценарий. Одиночная карточка уровня 3–4 (занятие преподавателя) ни в одну ступень не
идёт: «две карточки одновременно» она не проверяет.

Ступень 5 (HQ-033) — финальная смена: несколько карточек сразу из проработанных сценариев
каталога своей службы, телефон перегружен, вызов бригады подписан только бригадой
(`settings.final_shift`). Попытка ступени 5 — карточка такой смены (`StepAttempt.final`);
в ступень 4 она не идёт.

Показ (HQ-034): карточку тренировки «Смотрю» или «Как сделал бы опытный» ведёт курсор, а не
обучаемый (`settings.demo`, `StepAttempt.demo`). Такая карточка ни в одну ступень не идёт:
«Смотрю → Вместе → Сам» засчитывает только сделанное самим.
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
    # Уровни сценариев ступени: из них выбирает тренировка; у одиночных ступеней по ним же
    # считается попытка (`belongs`).
    levels: tuple[int, ...]
    required: int
    tutorial: bool = False
    # Одновременных карточек в тренировке этой ступени.
    parallel: int = 1
    # Финальная смена (HQ-033): попытки — только карточки смены с `final_shift`.
    final: bool = False


STEPS: tuple[Step, ...] = (
    Step(1, "Интерфейс и статусы", "Карточка от начала до конца с подсказчиком", (1,), 1, True),
    Step(2, "Своя карточка", "Принять, отметить этапы, доложить, завершить", (1,), 3),
    Step(3, "Сложные карточки", "Отказ, перенаправление, осложнения", (2,), 3),
    # HQ-032: пара — из проработанных сценариев своей службы, одна уровня 1 и одна уровня 2
    # (лист решений 18.10, `sessions/practice.py`); ряд из трёх зачтённых карточек, как у
    # других ступеней (смена из двух карточек и ещё одна).
    Step(4, "Параллельная работа", "Две карточки одновременно", (1, 2), 3, parallel=2),
    # [ASSUMPTION] HQ-033: финальная смена — три карточки разных происшествий из проработанных
    # сценариев каталога (с событиями и ветками) уровней 1–2; пройдена — три зачтённые подряд,
    # то есть вся смена без провала.
    Step(
        5,
        "Финальная смена",
        "Несколько карточек сразу, телефон перегружен, вызов подписан только бригадой",
        (1, 2),
        3,
        parallel=3,
        final=True,
    ),
)


@dataclass(frozen=True)
class StepAttempt:
    """Закрытая и оценённая карточка обучаемого."""

    level: int
    tutorial: bool
    passed: bool
    at: datetime
    # Карточка параллельной смены: у участника занятия по плану не одна карточка, и брать
    # их он мог по две и больше сразу.
    parallel: bool = False
    # Карточка финальной смены (`settings.final_shift`, HQ-033).
    final: bool = False
    # Показ курсором (`settings.demo`): карточку вёл не обучаемый — не попытка.
    demo: bool = False


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
    """Упражнение — ступень 1; карточка параллельной смены — ступень параллельной работы;
    одиночная карточка — ступень своего уровня; показ курсором — ни одна."""
    if attempt.demo:
        return False
    if step.tutorial:
        return attempt.tutorial
    if attempt.tutorial:
        return False
    if step.final:
        return attempt.final
    if attempt.final:
        return False
    if step.parallel > 1:
        return attempt.parallel
    return not attempt.parallel and attempt.level in step.levels


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
