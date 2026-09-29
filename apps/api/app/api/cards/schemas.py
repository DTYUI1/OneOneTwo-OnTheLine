from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from jsonschema import ValidationError
from pydantic import Field, RootModel, model_validator
from pydantic.json_schema import GetJsonSchemaHandler, JsonSchemaValue
from pydantic_core import CoreSchema

from app.api.foundation.schemas import ContractModel
from app.api.scenarios.schemas import CardSource
from app.core.contracts import read_json, validate_json


class ManualAddress(ContractModel):
    """Адрес, введённый обучаемым; исходный адрес карточки остаётся в source.address."""

    city: str = Field(max_length=200)
    street: str = Field(max_length=200)
    house: str = Field(max_length=200)
    building: str = Field(max_length=200)
    apartment: str = Field(max_length=200)


class CardCurrent(ContractModel):
    service_number: str = Field(max_length=64)
    comment: str = Field(max_length=4000)
    # null — ручной ввод адреса не выполнялся (у старых карточек поля нет).
    address: ManualAddress | None = None


class Card(ContractModel):
    id: UUID
    assignment_id: UUID
    trainee_id: UUID
    session_id: UUID
    state: Literal[
        "added",
        "received",
        "accepted",
        "rejected",
        "responding",
        "arrived",
        "working",
        "refused",
        "completed",
        "redirected",
    ]
    appeared_at: datetime
    delivered_at: datetime | None
    opened_at: datetime | None
    closed_at: datetime | None
    # Попытку прервало завершение занятия или перезапуск тренировки: таймеры стоят.
    interrupted_at: datetime | None
    source: CardSource
    current: CardCurrent


class CardEvent(RootModel[dict[str, Any]]):
    @model_validator(mode="before")
    @classmethod
    def validate_contract(cls, value: Any) -> Any:
        if isinstance(value, cls):
            return value
        try:
            validate_json(value, "https://arm112.local/contracts/card-event.schema.json")
        except ValidationError as exc:
            raise ValueError("Событие не соответствует контракту.") from exc
        return value

    @classmethod
    def __get_pydantic_json_schema__(
        cls, core_schema: CoreSchema, handler: GetJsonSchemaHandler
    ) -> JsonSchemaValue:
        return {
            key: value
            for key, value in read_json("contracts/card-event.schema.json").items()
            if key not in {"$id", "$schema"}
        }


class StoredEvent(ContractModel):
    id: UUID
    card_id: UUID
    actor_id: UUID
    client_event_id: UUID
    client_ts: datetime
    server_ts: datetime
    clock_offset_ms: float
    type: str
    payload: dict[str, Any]


class EventReceipt(ContractModel):
    client_event_id: UUID
    server_ts: datetime
    duplicate: bool
    card: Card


class Call(ContractModel):
    id: UUID
    card_id: UUID
    phone_ext: str
    service_id: str
    state: Literal["idle", "dialing", "ringing", "talking", "ended"]
    audio_url: str | None
    transcript: str | None
    # inbound — бригада позвонила диспетчеру сама с готовым докладом.
    direction: Literal["outbound", "inbound"] = "outbound"
