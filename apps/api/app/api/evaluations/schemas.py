from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import Field, field_validator, model_validator

from app.api.foundation.schemas import ContractModel

Score = Annotated[float, Field(ge=0, le=1, strict=True)]


class CriterionRemark(ContractModel):
    """Замечание разбора (TC-10): цитата, последствие, страница памятки ДДС, «Повторите: …»."""

    text: str
    quote: str | None
    consequence: str
    memo_page: Annotated[int, Field(ge=1, strict=True)]
    repeat: str
    kind: Literal["error", "notice", "data"]


class CriterionResult(ContractModel):
    key: str
    score: Score
    weight: Annotated[float, Field(ge=0, strict=True)]
    critical: bool
    evidence: list[str]
    explanation: str
    remarks: list[CriterionRemark] = Field(default_factory=list)


class AICheck(ContractModel):
    # ИИ-проверка комментария идёт или ждёт: модель одна, проверки по очереди.
    state: Literal["queued", "running", "failed"]
    # Сколько задач ИИ впереди (проверки и идущая порция генерации); у идущей — 0.
    ahead: Annotated[int, Field(ge=0)]


class Evaluation(ContractModel):
    id: UUID
    card_id: UUID
    trainee_id: UUID
    version: int
    status: Literal["partial", "complete"]
    total: Score
    criteria: list[CriterionResult]
    model_info: dict[str, str]
    teacher_comment: str
    ai_check: AICheck | None = None


class OverrideInput(ContractModel):
    evaluation_id: UUID
    decision: Literal["agree", "disagree"]
    new_total: Score | None
    reason: Annotated[str, Field(min_length=1, strict=True)]
    teacher_comment: str

    @field_validator("reason")
    @classmethod
    def reason_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Укажите обоснование изменения оценки.")
        return value.strip()

    @model_validator(mode="after")
    def validate_decision(self) -> Self:
        if self.decision == "agree" and self.new_total is not None:
            raise ValueError("Для согласия новая оценка не указывается.")
        if self.decision == "disagree" and self.new_total is None:
            raise ValueError("Для несогласия укажите новую оценку.")
        return self


class TraineeReport(ContractModel):
    user_id: UUID
    full_name: str
    workstation_number: int
    # None — не оценивалось/не измерено; UI и CSV показывают пусто, а не 0.
    total: Score | None
    reaction_time_s: Annotated[float, Field(ge=0)] | None
    handling_time_s: Annotated[float, Field(ge=0)] | None
    errors: Annotated[int, Field(ge=0)]
    level: Annotated[int, Field(ge=1, le=4)]


class PredictionFact(ContractModel):
    card_id: UUID
    p_success: Score
    expected_score: Score
    expected_time_s: Annotated[float, Field(ge=0)]
    actual_score: Score | None
    actual_time_s: Annotated[float, Field(ge=0)] | None


class Report(ContractModel):
    session_id: UUID
    trainees: list[TraineeReport]
    weakest_criteria: list[str]
    predictions: list[PredictionFact]
