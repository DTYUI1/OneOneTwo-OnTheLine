from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from evalcore.defaults import (
    BRIGADE_WEIGHTS,
    COMMENT_WEIGHTS,
    CRITERIA,
    PHONE_CONTACTS_MAX,
    REPORT_CHOICE_FACTOR,
)
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


class PhoneContact(ContractModel):
    """Абонент телефона ДДС (GP-09): роль, подпись в списке и условный номер."""

    role: Literal["head", "response_chief", "crew_chief", "crew_specialist", "caller"]
    name: Annotated[str, Field(min_length=1, max_length=60, strict=True)]
    number: Annotated[str, Field(pattern=r"^[4-9][0-9]{2}$", strict=True)]
    # Нет поля — характер сценария (ScenarioCaller.character); в настройки не пишется null.
    character: Literal["calm", "confused"] | None = Field(
        default=None,
        exclude_if=lambda value: value is None,
        description="Характер заявителя на этом занятии (роль caller, HQ-019): calm — "
        "спокойная, confused — растерянная. Нет поля — характер по умолчанию из сценария.",
    )


class Settings(ContractModel):
    reaction_normative_s: Annotated[int, Field(ge=1, strict=True)]
    handling_normative_s: Annotated[int, Field(ge=1, strict=True)]
    critical_cap: Annotated[float, Field(ge=0, le=1, strict=True)]
    weights: dict[str, Annotated[float, Field(ge=0, strict=True)]] = Field(
        description="Все семь весов обязательны; их сумма должна быть положительной и конечной. "
        "Веса критериев комментария spelling и comment_keywords — по желанию: без веса "
        "критерий не считается (занятия до 28.09). Так же вес brigade_work «Работа с "
        "бригадой» (DT-10): без веса не считается (занятия до 08.10).",
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
    voice_only: Annotated[bool, Field(strict=True)] = Field(
        default=False,
        description="Только голос: доклад службе в окне разговора — только голосом, варианты "
        "ответа не показываются (контрольное занятие, DT-05).",
    )
    final_shift: Annotated[bool, Field(strict=True)] = Field(
        default=False,
        description="Финальная смена (HQ-033, ступень 5): входящий вызов бригады подписан "
        "только бригадой (номер старшего) — без «по карточке N», карточку диспетчер находит "
        "сам по номеру направленной бригады. Попытки такой смены идут в ступень 5.",
    )
    demo: Annotated[bool, Field(strict=True)] = Field(
        default=False,
        description="Показ (HQ-034): тренировку «Смотрю» или «Как сделал бы опытный» ведёт "
        "курсор, а не обучаемый. Её карточки не идут ни в ступени обучения, ни в «Мои "
        "результаты».",
    )
    demo_mode: Literal["watch", "expert"] | None = Field(
        default=None,
        description="Вид показа (HQ-035): watch — «Смотрю», expert — «Как сделал бы опытный». "
        "Перехватить («Беру управление») можно только watch. Без показа — null.",
    )
    report_choice_factor: Annotated[float, Field(ge=0, le=1, strict=True)] = Field(
        default=REPORT_CHOICE_FACTOR,
        description="Доля балла за доклад службе вариантом ответа от такого же доклада "
        "голосом: 1 — без разницы, 0 — не засчитывать.",
    )
    phone_contacts: dict[
        str, Annotated[list[PhoneContact], Field(max_length=PHONE_CONTACTS_MAX)]
    ] = Field(
        default_factory=dict,
        description="Абоненты телефона ДДС по службе (GP-09, рекомендации 16.10, п. 8): "
        "руководитель организации, начальник отдела реагирования, начальник и специалист "
        "аварийной бригады, заявитель — не больше 10 на ДДС. Нет ключа службы — список по "
        "умолчанию (evalcore.defaults.DEFAULT_PHONE_CONTACTS), пустой список — абонентов нет. "
        "Номер вне списка не отвечает; заявитель доступен, только если он в списке.",
    )

    @field_validator("phone_contacts")
    @classmethod
    def validate_phone_contacts(
        cls, value: dict[str, list[PhoneContact]]
    ) -> dict[str, list[PhoneContact]]:
        """Номер в списке одной ДДС — у одного абонента: иначе неясно, кто ответит."""
        for service_id, items in value.items():
            numbers = [item.number for item in items]
            if len(numbers) != len(set(numbers)):
                raise ValueError(f"Номера абонентов ДДС {service_id} повторяются.")
        return value

    @field_validator("weights")
    @classmethod
    def validate_weights(cls, value: dict[str, float]) -> dict[str, float]:
        """Применить ту же проверку, что оценщик, и к snapshot занятия."""
        configured_weights({"weights": dict(value)})
        return value


def with_comment_defaults(value: dict[str, Any]) -> dict[str, Any]:
    """Настройки, сохранённые до 28.09 (08.10): добавить веса необязательных критериев —
    комментария и работы с бригадой — по умолчанию."""
    weights = dict(value.get("weights", {}))
    for key, weight in {**COMMENT_WEIGHTS, **BRIGADE_WEIGHTS}.items():
        weights.setdefault(key, weight)
    return {**value, "weights": weights}


class DemoAccount(ContractModel):
    login: str
    role: Literal["trainee", "teacher", "admin"]
    full_name: str


class DemoAccounts(ContractModel):
    enabled: bool
    password: str | None
    accounts: list[DemoAccount]


class Health(ContractModel):
    status: Literal["ok", "degraded"]
    mode: Literal["mock", "skeleton", "database"]
    database: Literal["not_connected", "ok", "error"]
    worker: Literal["stub", "ok", "error"]
    ai_provider: str
