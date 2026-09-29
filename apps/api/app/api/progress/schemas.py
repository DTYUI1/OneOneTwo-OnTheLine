from typing import Annotated
from uuid import UUID

from pydantic import Field

from app.api.foundation.schemas import ContractModel


class StepProgressView(ContractModel):
    number: Annotated[int, Field(ge=1, le=4)]
    title: str
    skill: str
    required: Annotated[int, Field(ge=1, description="Сколько подряд зачтённых попыток нужно.")]
    attempts: Annotated[int, Field(ge=0)]
    streak: Annotated[
        int, Field(ge=0, description="Текущий ряд подряд зачтённых, не больше required.")
    ]
    passed: bool
    unlocked: bool


class TraineeProgress(ContractModel):
    user_id: UUID
    full_name: str
    current_step: Annotated[int, Field(ge=1, le=4)]
    steps: list[StepProgressView]
