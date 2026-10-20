from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field

from app.api.c01 import TimingPolicy
from app.api.foundation.schemas import ContractModel, Settings
from app.worker.generators.themes import Category


class Participant(ContractModel):
    user_id: UUID
    workstation_number: Annotated[int, Field(ge=1, le=23, strict=True)]
    dds_service_id: str
    level: Annotated[int, Field(ge=1, le=4, strict=True)]


class AISelection(ContractModel):
    categories: list[Category] = Field(default_factory=list)
    request_id: UUID
    cards_per_participant: Annotated[int, Field(ge=1, le=4, strict=True)] = 1
    generation_policy: Literal["after_lessons", "now"] = "after_lessons"


class AIParticipantRecommendation(ContractModel):
    user_id: UUID
    service_id: str
    level: int
    weight: int
    based_on_attempts: int
    explanation: str


class AIPreparation(ContractModel):
    job_id: UUID
    state: Literal["waiting", "queued", "generating", "ready", "failed", "stopping", "cancelled"]
    cards_per_participant: int
    completed: int
    total: int
    warnings: list[str]
    recommendations: list[AIParticipantRecommendation]


class SessionInput(ContractModel):
    title: Annotated[str, Field(min_length=1, max_length=300, strict=True)]
    participants: list[Participant]
    settings_snapshot: Settings
    timing_policy: TimingPolicy | None = None
    ai_selection: AISelection | None = None


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
    ai_preparation: AIPreparation | None = None
    start_pending: bool = False
    start_error: str | None = None


class StartInput(ContractModel):
    mode: Literal["now", "wait", "cancel"]
    request_id: UUID | None = None


class SessionNormsInput(ContractModel):
    handling_normative_s: Annotated[int, Field(ge=1, le=3600, strict=True)]


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


class PracticeScenario(ContractModel):
    """Строка каталога сценариев обучаемого: проработанный сценарий, который можно пройти
    сам. Эталон не отдаётся — только то, что и так видно в карточке, и чему учит."""

    id: UUID
    version: int
    title: str
    service_id: str
    service_name: str
    level: Annotated[int, Field(ge=1, le=4, strict=True)]
    description: str
    # Виды событий сценария (ScenarioEvent.kind) в порядке плана, без повторов.
    trains: list[str]
