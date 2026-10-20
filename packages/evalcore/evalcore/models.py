from dataclasses import dataclass
from typing import Literal, Protocol

type Json = None | bool | int | float | str | list[Json] | dict[str, Json]

# Вид замечания разбора (TC-10): ошибка снижает балл; замечание без снижения балла — только
# сведение (статусы подряд быстрее порога); вопрос к данным — ошибка в данных сценария, она
# обучаемому не вменяется.
type RemarkKind = Literal["error", "notice", "data"]


@dataclass(frozen=True)
class Remark:
    """Замечание разбора (TC-10, contracts/evalcore.md «Замечания разбора»).

    Не минус, а что случилось бы в мире (`consequence`), где это в памятке ДДС
    (`memo_page`) и что сделать в следующий раз (`repeat`, «Повторите: …»). `quote` —
    фрагмент сказанного или написанного обучаемым (±45 символов вокруг найденного); нет
    цитаты — None.
    """

    text: str
    consequence: str
    memo_page: int
    repeat: str
    quote: str | None = None
    kind: RemarkKind = "error"


@dataclass(frozen=True)
class CriterionResult:
    key: str
    score: float
    weight: float
    critical: bool
    evidence: list[str]
    explanation: str
    # Замечания разбора (TC-10): у каждой ошибки критерия — своё; пусто — замечаний нет.
    remarks: tuple[Remark, ...] = ()


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
    # Доклады плана занятия: {message_id, justifies_state | None, presented_at | None,
    # task_change? — доклад меняет задачу, TC-05, evalcore/task_change.py}.
    # Пусто — у сценария нет плана докладов, ход статусов оценивается по эталону целиком.
    planned_messages: tuple[dict[str, Json], ...] = ()
    # Нужна, только если в settings.weights заданы критерии комментария (COMMENT_CRITERIA).
    text_checker: TextChecker | None = None
    # События бригады, сработавшие на карточке (DT-10, evalcore/brigade.py): {event
    # (ScenarioEvent, brigade_id — исполнитель роли), fired_at, source: plan | inject,
    # presented_at | None — первое предъявление реплики, replies: [{at, option_key}]}.
    scenario_events: tuple[dict[str, Json], ...] = ()
    # Вводные бригадам (GP-05, таблица brigade_briefings): {brigade_id, at, mode, text,
    # address: ok | wrong | missing, heard_address, incident, complete} в порядке времени.
    briefings: tuple[dict[str, Json], ...] = ()
    # Реплики собеседников по карточке (HQ-020, evalcore/comment.py): {text, presented_at |
    # None} — всё, что сценарий может сказать обучаемому (доклады плана, реплики событий и
    # веток, подмены), и момент первого предъявления. Пусто — источник сведений не проверяется.
    lines: tuple[dict[str, Json], ...] = ()
    # Прямые номера бригад, направленных на карточку («Старший бригады · 201», CardBrigade →
    # CallTarget.phone_ext): с ними сверяется «Номер наряда». Пусто — бригады не направлялись,
    # номер проверяется только на заполненность.
    brigade_numbers: tuple[str, ...] = ()


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
