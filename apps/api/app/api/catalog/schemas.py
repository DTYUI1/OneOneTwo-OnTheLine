from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field

from app.api.foundation.schemas import ContractModel


class Service(ContractModel):
    id: str
    code: str
    name: str
    category: str
    phone_ext: Annotated[str, Field(pattern="^[0-9]{3}$")]
    phone: Annotated[
        str | None,
        Field(
            pattern=r"^\+7[0-9]{10}$",
            description=(
                "Городской номер службы в справочнике телефона ДДС, кроме короткого "
                "phone_ext: набранный, он соединяет с той же службой. Номера учебные."
            ),
        ),
    ] = None
    voice_profile: str
    is_active: bool


class ServiceUpdate(ContractModel):
    """C-07: служба включается и выключается администратором; справочник не удаляется."""

    is_active: Annotated[bool, Field(strict=True)]


class IncidentType(ContractModel):
    code: str
    name: str
    group_name: str
    main_service_code: str


class Pack(ContractModel):
    id: UUID
    created_at: datetime | None = Field(default=None, json_schema_extra={"readOnly": True})
    title: str
    status: Literal["draft", "approved", "retired"]
    scenario_ids: list[UUID]
    origin: Literal["template", "llm", "imported"]
