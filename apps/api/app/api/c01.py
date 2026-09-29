"""Границы spec-first C-01: строгий ввод и честный отказ до C-02…C-07."""

import json
from typing import Any, ClassVar
from uuid import UUID

from fastapi import HTTPException, Request
from jsonschema import ValidationError
from pydantic import RootModel, model_validator
from pydantic.json_schema import GetJsonSchemaHandler, JsonSchemaValue
from pydantic_core import CoreSchema

from app.core.contracts import read_json, validate_json

PENDING_EVENTS = {"brigades_select", "call_dial_target", "message_presented", "message_failed"}
# Дефолты новой методики берутся из контракта, а не из констант кода (I-TIME v3).
DEFAULT_TIMING_POLICY: dict[str, Any] = read_json("contracts/c01.schema.json")["$defs"][
    "TimingPolicy"
]["examples"][1]
assert DEFAULT_TIMING_POLICY["timing_version"] == 3


class C01Input(RootModel[dict[str, Any]]):
    """JSON Schema — источник новых spec-first тел, как для CardEvent."""

    contract_name: ClassVar[str]

    @model_validator(mode="before")
    @classmethod
    def validate_contract(cls, value: Any) -> Any:
        if isinstance(value, cls):
            return value
        try:
            validate_json(value, f"urn:openapi#/components/schemas/{cls.contract_name}")
        except ValidationError as exc:
            raise ValueError("Данные не соответствуют контракту C-01.") from exc
        return value

    @classmethod
    def __get_pydantic_json_schema__(
        cls, core_schema: CoreSchema, handler: GetJsonSchemaHandler
    ) -> JsonSchemaValue:
        return read_json("contracts/openapi.draft.yaml")["components"]["schemas"][cls.contract_name]


class TimingPolicy(C01Input):
    contract_name = "TimingPolicy"


class GenerateOptions(C01Input):
    contract_name = "GenerateOptions"


class FinishInput(C01Input):
    contract_name = "FinishInput"


def pending(owner: str) -> None:
    """Не подменять контрактный пример успешным runtime-результатом."""
    # MVP-STUB капитан C-02…C-07: реализация поставляется отдельно от C-01.
    raise HTTPException(501, f"Контракт подготовлен; реализация ожидает {owner}.")


def reject_extensions(operation_id: str, body: Any, role: str) -> None:
    """Старые запросы работают; новые параметры запрещено молча игнорировать."""
    if not isinstance(body, dict):
        return
    teacher_extension = (
        (operation_id == "createSession" and "timing_policy" in body)
        or (operation_id == "generatePack" and "options" in body)
        or operation_id == "finishSession"
    )
    trainee_extension = operation_id == "postEvent" and (
        "clock_sample_id" in body or body.get("type") in PENDING_EVENTS
    )
    if (teacher_extension and role != "teacher") or (trainee_extension and role != "trainee"):
        raise HTTPException(403, "Недостаточно прав для учебного действия.")
    if operation_id == "createSession" and "timing_policy" in body:
        pending("C-02")
    if operation_id == "generatePack" and "options" in body:
        pending("C-05")
    if operation_id == "finishSession":
        pending("C-03")
    if operation_id == "postEvent":
        if "clock_sample_id" in body:
            pending("C-02")
        if body.get("type") in PENDING_EVENTS:
            pending("C-04")


async def validate_pending(request: Request, operation: dict[str, Any]) -> None:
    """Проверить доступный без бизнес-реализации формат нового запроса."""
    try:
        for param in operation.get("parameters", []):
            if param["in"] == "path" and param["schema"].get("format") == "uuid":
                UUID(request.path_params[param["name"]])
        content = operation.get("requestBody", {}).get("content", {})
        if "application/json" in content:
            body = await request.json()
            schema = content["application/json"]["schema"]["$ref"]
            validate_json(body, "urn:openapi" + schema)
    except (ValueError, ValidationError, json.JSONDecodeError) as exc:
        raise HTTPException(422, "Запрос не соответствует контракту C-01.") from exc
