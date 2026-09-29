from typing import Annotated, Any, Literal
from uuid import UUID

from jsonschema import ValidationError
from pydantic import Field, RootModel, WithJsonSchema, model_validator
from pydantic.json_schema import GetJsonSchemaHandler, JsonSchemaValue
from pydantic_core import CoreSchema

from app.api.foundation.schemas import ContractModel
from app.core.contracts import read_json, validate_json

SCENARIO_SCHEMA = read_json("contracts/scenario.schema.json")


class CardSource(RootModel[dict[str, Any]]):
    # Общая JSON Schema остаётся источником вложенных полей для API и evalcore.
    @classmethod
    def __get_pydantic_json_schema__(
        cls, core_schema: CoreSchema, handler: GetJsonSchemaHandler
    ) -> JsonSchemaValue:
        return {
            key: value
            for key, value in read_json("contracts/card.schema.json").items()
            if key not in {"$id", "$schema"}
        }


class Scenario(ContractModel):
    id: UUID
    version: Annotated[int, Field(ge=1)]
    level: Annotated[int, Field(ge=1, le=4)]
    weight: Annotated[int, Field(ge=1, le=10)]
    incident_type_code: str
    target_service_id: str
    card: CardSource
    reference: Annotated[dict[str, Any], WithJsonSchema(SCENARIO_SCHEMA["properties"]["reference"])]
    complications: list[
        Literal["wrong_address", "duplicate", "no_phone", "no_contact", "emergency", "parallel"]
    ]
    origin: Literal["template", "llm", "imported", "trainee"]
    status: Literal["draft", "approved", "retired"]
    teacher_comment: str

    @model_validator(mode="before")
    @classmethod
    def validate_contract(cls, value: Any) -> Any:
        if isinstance(value, cls):
            return value
        try:
            # До приведения типов: строка «1» и boolean не должны стать integer.
            validate_json(value, SCENARIO_SCHEMA["$id"])
        except ValidationError as exc:
            raise ValueError("Сценарий не соответствует контракту.") from exc
        return value
