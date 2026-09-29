"""Чистые сигнатуры V-02/V-03 и C-05; реализаций/новой формулы здесь нет."""

from dataclasses import dataclass
from typing import Literal, Protocol

from evalcore.models import CriterionResult, EvalContext, Json, Prediction, Trainee
from evalcore.timing_contract import TimingPolicy, TimingResult


@dataclass(frozen=True)
class PresentedInformation:
    delivery_id: str
    message_id: str
    message_version: int
    presentation_event_id: str
    presented_at: str
    text: str
    channel: Literal["audio", "text"]


@dataclass(frozen=True)
class ErrorCounts:
    input: int | None
    address: int | None
    grammar: int | None
    routing: int | None
    status_flow: int | None
    timing: int | None
    call: int | None


@dataclass(frozen=True)
class LayerResult:
    layer: Literal["rules", "address", "grammar", "semantic", "llm", "information"]
    status: Literal["done", "pending", "unavailable", "failed", "not_applicable"]
    version: str | None
    reason: str | None
    evidence: list[str]
    explanation: str


@dataclass(frozen=True)
class SupplementalResult:
    criteria: list[CriterionResult]
    layers: list[LayerResult]
    errors: ErrorCounts


@dataclass(frozen=True)
class PredictionContext:
    """Вход прогноза v2: политика именно прогнозируемого занятия, без текущих settings."""

    contract_version: Literal[2]
    snapshot_id: str
    policy: TimingPolicy


@dataclass(frozen=True)
class CalibrationObservation:
    card_id: str
    prediction_id: str
    made_at: str
    completed_at: str
    predicted_score: float
    automatic_score: float
    effective_score: float
    override_id: str | None
    handling_s: float | None
    timing_version: Literal[1, 2]
    snapshot_id: str | None
    handling_normative_s: float | None
    timing_quality: Literal["verified", "estimated", "invalid", "legacy"] | None
    level: int
    weight: int


@dataclass(frozen=True)
class Recommendation:
    level: int
    weight: int
    direction: Literal["increase", "keep", "decrease"]
    based_on_attempts: int
    model_version: str
    methodology_version: str
    evidence: list[str]
    explanation: str


class SupplementalEvaluator(Protocol):
    def __call__(
        self, ctx: EvalContext, *, timing: TimingResult, information: list[PresentedInformation]
    ) -> SupplementalResult:
        """V-02: оценивать только доступные свидетельства; отсутствие слоя явно описать."""
        ...


class SessionPredictor(Protocol):
    def __call__(
        self, trainee: Trainee, scenario: dict[str, Json], *, context: PredictionContext
    ) -> Prediction:
        """V-03: p_timeout = P(handling_s > context.policy.handling_normative_s)."""
        ...


class RatingUpdater(Protocol):
    def __call__(self, trainee: Trainee, history: list[CalibrationObservation]) -> Trainee:
        """V-03: использовать завершённые прошлые попытки и effective override."""
        ...


class LevelRecommender(Protocol):
    def __call__(self, trainee: Trainee, history: list[CalibrationObservation]) -> Recommendation:
        """V-03: вернуть уровень 1…4 и вес 1…10 с основаниями без будущих фактов."""
        ...


class ScenarioBuilder(Protocol):
    def __call__(self, constructor: dict[str, Json]) -> dict[str, Json]:
        """C-05: ScenarioConstructor → ScenarioPreview; seed внутри входа, без I/O."""
        ...
