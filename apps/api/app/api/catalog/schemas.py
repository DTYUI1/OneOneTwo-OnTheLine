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
    title: str
    status: Literal["draft", "approved", "retired"]
    scenario_ids: list[UUID]
    origin: Literal["template", "llm", "imported"]
