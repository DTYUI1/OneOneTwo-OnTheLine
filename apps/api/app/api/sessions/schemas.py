from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field

from app.api.c01 import TimingPolicy
from app.api.foundation.schemas import ContractModel, Settings


class Participant(ContractModel):
    user_id: UUID
    workstation_number: Annotated[int, Field(ge=1, le=23, strict=True)]
    dds_service_id: str
    level: Annotated[int, Field(ge=1, le=4, strict=True)]


class SessionInput(ContractModel):
    title: Annotated[str, Field(min_length=1, max_length=300, strict=True)]
    participants: list[Participant]
    settings_snapshot: Settings
    timing_policy: TimingPolicy | None = None


class Session(ContractModel):
    id: UUID
    title: str
    teacher_id: UUID
    status: Literal["draft", "running", "finished"]
    participants: list[Participant]
    settings_snapshot: Settings
    kind: Literal["lesson", "practice"] = "lesson"
    # По ним кабинет выбирает свежее идущее занятие и показывает его длительность.
    started_at: datetime | None = None
    finished_at: datetime | None = None


class AssignmentInput(ContractModel):
    participant_id: UUID
    scenario_id: UUID
    order: Annotated[int, Field(ge=1, strict=True)]
    planned_at: datetime


class Assignment(ContractModel):
    id: UUID
    session_id: UUID
    participant_id: UUID
    scenario_id: UUID
    order: int
    planned_at: datetime
    status: Literal["pending", "delivered", "completed"]
