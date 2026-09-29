from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field

from app.api.c01 import GenerateOptions
from app.api.foundation.schemas import ContractModel


class GenerateInput(ContractModel):
    count: Annotated[int, Field(ge=1, le=100, strict=True)]
    level: Annotated[int, Field(ge=1, le=4, strict=True)]
    service_id: str
    seed: int
    options: GenerateOptions | None = None


class Job(ContractModel):
    id: UUID
    kind: Literal["generate", "evaluate", "insights", "transcribe", "tts"]
    status: Literal["pending", "running", "done", "failed"]
    error: str | None
