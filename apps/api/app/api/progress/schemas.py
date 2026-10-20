from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field

from app.api.foundation.schemas import ContractModel


class StepProgressView(ContractModel):
    number: Annotated[int, Field(ge=1, le=5)]
    title: str
    skill: str
    required: Annotated[int, Field(ge=1, description="Сколько подряд зачтённых попыток нужно.")]
    attempts: Annotated[int, Field(ge=0)]
    streak: Annotated[
        int, Field(ge=0, description="Текущий ряд подряд зачтённых, не больше required.")
    ]
    passed: bool
    unlocked: bool


class AdviceFocus(ContractModel):
    """Слабое место: критерий оценки (ключ evalcore), его название и совет одной фразой."""

    criterion: str
    label: str
    text: str


class AdviceCheck(ContractModel):
    """Слабое место прошлой рекомендации и отметка новой попытки (TC-11): done — критерий
    проверялся и выполнен полностью, not_done — балл ниже полного, unchecked — сценарий новой
    попытки этот критерий не проверял."""

    criterion: str
    label: str
    text: str
    status: Literal["done", "not_done", "unchecked"]


class PreviousAdvice(ContractModel):
    """Прошлая рекомендация — по оценённым карточкам до новой попытки — и как её выполнила
    новая попытка (TC-11)."""

    card_id: Annotated[
        UUID, Field(description="Новая попытка: последняя оценённая закрытая карточка.")
    ]
    focus: list[AdviceCheck]


class Advice(ContractModel):
    """Рекомендация к дальнейшему обучению (GP-14): что подтянуть — слабые критерии оценки
    последних карточек (focus, не больше двух) — и следующий шаг пути обучения."""

    based_on: Annotated[int, Field(ge=1, description="Сколько последних оценённых карточек.")]
    focus: list[AdviceFocus]
    next_step: Annotated[int, Field(ge=1, le=4)]
    next: str
    summary: str
    previous: Annotated[
        PreviousAdvice | None,
        Field(
            description="Прошлая рекомендация и её выполнение новой попыткой (TC-11); null — "
            "оценённая карточка одна или в прошлой рекомендации не было слабых мест."
        ),
    ] = None


class ScenarioRepeat(ContractModel):
    """Повтор незачтённого сценария в «Моём пути» (TC-11): было → стало."""

    scenario_id: UUID
    number: Annotated[str, Field(description="Номер карточки сценария.")]
    incident_class: str
    step: Annotated[int, Field(ge=2, le=4, description="Ступень по уровню сценария.")]
    was: Annotated[float, Field(ge=0, le=1, description="Балл первой незачтённой попытки.")]
    now: Annotated[
        Annotated[float, Field(ge=0, le=1)] | None,
        Field(description="Балл последней попытки после неё; null — повтора ещё не было."),
    ]
    passed: Annotated[
        bool, Field(description="Последняя попытка после незачтённой зачтена: исправлено.")
    ]
    last_card_id: Annotated[UUID, Field(description="Последняя попытка этого сценария.")]


class TraineeProgress(ContractModel):
    user_id: UUID
    full_name: str
    current_step: Annotated[int, Field(ge=1, le=5)]
    steps: list[StepProgressView]
    advice: Annotated[
        Advice | None,
        Field(
            description="Рекомендация к дальнейшему обучению по последним оценённым "
            "карточкам (GP-14); null — оценённых карточек ещё нет."
        ),
    ] = None
    repeats: Annotated[
        list[ScenarioRepeat],
        Field(
            description="Незачтённые сценарии, которые можно пройти повтором "
            "(POST /practice?scenario_id=…), и их «было → стало» (TC-11): сначала не "
            "исправленные, затем новые первыми, не больше трёх."
        ),
    ] = []
