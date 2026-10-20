from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, model_validator

from app.api.foundation.schemas import ContractModel

# address — «Найди отличие в адресе», routing — «Кого направить» (решение тимлида 03.10).
Kind = Literal["address", "routing"]

Mistake = Annotated[str, Field(min_length=1, max_length=300, strict=True)]


class WarmupResultInput(ContractModel):
    kind: Kind
    correct: Annotated[int, Field(ge=0, le=100, strict=True)]
    total: Annotated[int, Field(ge=1, le=100, strict=True)]
    # Время упражнения: от первого задания до последнего ответа, не больше часа.
    duration_ms: Annotated[int, Field(ge=0, le=3_600_000, strict=True)]
    # Что ответили неверно — чтобы вернуть эти задания в следующую разминку.
    mistakes: Annotated[list[Mistake], Field(max_length=50)]

    @model_validator(mode="after")
    def correct_within_total(self) -> "WarmupResultInput":
        if self.correct > self.total:
            raise ValueError("Верных ответов не может быть больше, чем заданий.")
        return self


class WarmupResult(ContractModel):
    id: UUID
    trainee_id: UUID
    trainee_name: str
    kind: Kind
    correct: int
    total: int
    duration_ms: int
    mistakes: list[str]
    created_at: datetime
