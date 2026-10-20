from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field

from app.api.c01 import GenerateOptions
from app.api.foundation.schemas import ContractModel
from app.worker.generators.themes import Category


class GenerateInput(ContractModel):
    trainee_login: Annotated[str, Field(min_length=1, max_length=100)] | None = None
    categories: list[Category] = Field(default_factory=list)
    count: Annotated[int, Field(ge=1, le=100, strict=True)]
    level: Annotated[int, Field(ge=1, le=4, strict=True)]
    service_id: str
    seed: int | None = None
    options: GenerateOptions | None = None
    generation_request_id: UUID | None = None
    generation_policy: Literal["after_lessons", "now"] = "after_lessons"


class AIResourceState(ContractModel):
    local_ai: bool
    lesson_running: bool
    generation_running: bool


class Job(ContractModel):
    id: UUID
    kind: Literal["generate", "evaluate", "insights", "transcribe", "tts"]
    status: Literal["pending", "running", "done", "failed", "cancelled"]
    error: str | None


class GenerationVariety(ContractModel):
    count: int
    variants_total: Annotated[int, Field(ge=0)]
    variants_left: Annotated[int, Field(ge=0)]


class GenerationTrainee(ContractModel):
    id: UUID
    login: str
    full_name: str
    dds_service_id: str | None
    recommended_level: Annotated[int, Field(ge=1, le=4)]
    explanation: str
