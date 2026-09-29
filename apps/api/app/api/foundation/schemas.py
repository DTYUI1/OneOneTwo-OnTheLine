from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from evalcore.defaults import COMMENT_WEIGHTS, CRITERIA
from evalcore.scoring import configured_weights
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True, allow_inf_nan=False)


class Login(ContractModel):
    login: Annotated[str, Field(min_length=1, strict=True)]
    password: Annotated[str, Field(min_length=1, strict=True)]


Role = Literal["trainee", "teacher", "admin"]
Workstation = Annotated[int, Field(ge=1, le=23, strict=True)]
FullName = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120, strict=True)
]
# Логин вводится один раз и не меняется: ссылки в журналах и отчётах остаются понятными.
LoginName = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9._-]{2,31}$", strict=True)]
Password = Annotated[str, Field(min_length=8, max_length=128, strict=True)]


class User(ContractModel):
    id: UUID
    login: str
    full_name: str
    role: Role
    workstation_number: Annotated[int, Field(ge=1, le=23)] | None
    dds_service_id: str | None
    is_active: bool
    # Корзина C-07: учётка помечена на удаление (и заблокирована); отчёты и журнал по-прежнему
    # находят человека по id, после резервной копии — под обезличенным именем.
    deleted_at: datetime | None = None


class UserCreate(ContractModel):
    """C-07: учётная запись любой роли; АРМ и служба профиля — только у обучаемого."""

    login: LoginName
    full_name: FullName
    role: Role
    password: Password
    workstation_number: Workstation | None
    dds_service_id: Annotated[str, Field(min_length=1, strict=True)] | None


class UserUpdate(ContractModel):
    """Все изменяемые поля сразу; is_active=false блокирует вход и отзывает сессии."""

    full_name: FullName
    role: Role
    workstation_number: Workstation | None
    dds_service_id: Annotated[str, Field(min_length=1, strict=True)] | None
    is_active: Annotated[bool, Field(strict=True)]


class PasswordReset(ContractModel):
    password: Password


class TrashInput(ContractModel):
    """Причина удаления попадает в журнал аудита и видна в корзине."""

    reason: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=3, max_length=300, strict=True)
    ]


class TrashItem(ContractModel):
    """waiting_backup — ждёт копии; ready — копия есть, worker скоро обезличит; purged — готово."""

    kind: Literal["user"]
    id: UUID
    title: str
    login: str
    role: Role
    reason: str | None
    deleted_at: datetime
    deleted_by: UUID | None
    purged_at: datetime | None
    state: Literal["waiting_backup", "ready", "purged"]


class TrashList(ContractModel):
    # Начало последней успешной копии: всё, что помечено раньше, в ней уже есть.
    last_backup_at: datetime | None
    items: list[TrashItem]


class BackupRun(ContractModel):
    """Резервная копия: ночная и консольная — requested_by null, по кнопке — администратор."""

    id: UUID
    status: Literal["pending", "running", "done", "failed"]
    requested_by: UUID | None
    requested_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    name: str | None
    error: str | None


class Settings(ContractModel):
    reaction_normative_s: Annotated[int, Field(ge=1, strict=True)]
    handling_normative_s: Annotated[int, Field(ge=1, strict=True)]
    critical_cap: Annotated[float, Field(ge=0, le=1, strict=True)]
    weights: dict[str, Annotated[float, Field(ge=0, strict=True)]] = Field(
        description="Все семь весов обязательны; их сумма должна быть положительной и конечной. "
        "Веса критериев комментария spelling и comment_keywords — по желанию: без веса "
        "критерий не считается (занятия до 28.09).",
        json_schema_extra={
            "required": list(CRITERIA),
            "anyOf": [{"properties": {key: {"exclusiveMinimum": 0}}} for key in CRITERIA],
        },
    )
    parallel_cards: Annotated[int, Field(ge=1, le=23, strict=True)]
    hints_level: Annotated[int, Field(ge=0, le=1, strict=True)]
    spelling_hints: Annotated[bool, Field(strict=True)] = Field(
        default=False,
        description="Подсказки орфографии под комментарием в АРМ (учебный режим). "
        "Проверка грамотности при оценке идёт всегда, если задан вес spelling.",
    )

    @field_validator("weights")
    @classmethod
    def validate_weights(cls, value: dict[str, float]) -> dict[str, float]:
        """Применить ту же проверку, что оценщик, и к snapshot занятия."""
        configured_weights({"weights": dict(value)})
        return value


def with_comment_defaults(value: dict[str, Any]) -> dict[str, Any]:
    """Настройки, сохранённые до 28.09: добавить веса критериев комментария по умолчанию."""
    weights = dict(value.get("weights", {}))
    for key, weight in COMMENT_WEIGHTS.items():
        weights.setdefault(key, weight)
    return {**value, "weights": weights}


class Health(ContractModel):
    status: Literal["ok", "degraded"]
    mode: Literal["mock", "skeleton", "database"]
    database: Literal["not_connected", "ok", "error"]
    worker: Literal["stub", "ok", "error"]
    ai_provider: str
