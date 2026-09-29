from dataclasses import dataclass
from typing import Protocol

type Json = None | bool | int | float | str | list[Json] | dict[str, Json]


@dataclass(frozen=True)
class CriterionResult:
    key: str
    score: float
    weight: float
    critical: bool
    evidence: list[str]
    explanation: str


@dataclass(frozen=True)
class SpellingIssue:
    """Слово не найдено в словаре: позиция в тексте и варианты исправления."""

    start: int
    end: int
    word: str
    suggestions: tuple[str, ...]


class TextChecker(Protocol):
    """Проверка русского текста. Реализация со словарём — в API (app/core/spelling.py):
    evalcore остаётся без зависимостей."""

    def check(self, text: str) -> list[SpellingIssue]:
        """Слова текста, которых нет в словаре, с вариантами исправления."""
        ...

    def lemmas(self, word: str) -> frozenset[str]:
        """Начальные формы слова (все разборы), в нижнем регистре, «ё» → «е»."""
        ...


@dataclass(frozen=True)
class EvalContext:
    scenario: dict[str, Json]
    current: dict[str, Json]
    events: list[dict[str, Json]]
    calls: list[dict[str, Json]]
    settings: dict[str, Json]
    streets: tuple[str, ...] = ()
    routing_rules: tuple[dict[str, Json], ...] = ()
    # Доклады плана занятия: {message_id, justifies_state | None, presented_at | None}.
    # Пусто — у сценария нет плана докладов, ход статусов оценивается по эталону целиком.
    planned_messages: tuple[dict[str, Json], ...] = ()
    # Нужна, только если в settings.weights заданы критерии комментария (COMMENT_CRITERIA).
    text_checker: TextChecker | None = None


@dataclass(frozen=True)
class Evaluation:
    total: float
    criteria: list[CriterionResult]
    critical_flags: list[str]


@dataclass(frozen=True)
class Trainee:
    theta: float
    log_time_mean: float
    log_time_variance: float


@dataclass(frozen=True)
class Prediction:
    p_success: float
    expected_score: float
    expected_time_s: float
    p_timeout: float
    model_version: str


class Criterion(Protocol):
    key: str

    def evaluate(self, ctx: EvalContext) -> CriterionResult:
        """Вернуть нормированный балл 0..1 и факты, подтверждающие результат."""
        ...
