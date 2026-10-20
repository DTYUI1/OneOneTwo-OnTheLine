from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field

from app.api.foundation.schemas import ContractModel

# Виды событий бригады (contracts/scenario-events.md, «Принято 08.10» и 11.10).
Kind = Literal["clarify", "request_service", "silence", "alarm", "readback_error"]


class InjectInput(ContractModel):
    kind: Kind
    # «all» — всем местам занятия, иначе — обучаемые (user_id, как participant_id в назначениях).
    targets: Literal["all"] | Annotated[list[UUID], Field(min_length=1, max_length=50)]


class InjectResult(ContractModel):
    participant_id: UUID
    workstation: int
    trainee_name: str
    status: Literal["fired", "not_applicable"]
    card_id: UUID | None
    card_number: str | None
    # Почему не подана — для преподавателя: «Рано: карточка ещё не дошла до нужного статуса».
    reason: str | None


class InjectReceipt(ContractModel):
    kind: Kind
    results: list[InjectResult]


class InjectOption(ContractModel):
    kind: Kind
    title: str
    # Сколько открытых карточек занятия могут принять вводную этого вида.
    cards: int


class InjectFiring(ContractModel):
    id: UUID
    kind: Kind
    title: str
    card_id: UUID
    card_number: str
    participant_id: UUID
    workstation: int
    trainee_name: str
    fired_at: datetime


class InjectOverview(ContractModel):
    options: list[InjectOption]
    fired: list[InjectFiring]
