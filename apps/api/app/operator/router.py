"""API разговора и сохранения попытки (contracts/operator/dialog.md,
contracts/operator/evaluation.md, contracts/operator/voice.md).

Без своих таблиц (OP-01 отложена): состояние заявителя хранит клиент; попытки — в общем
`audit_log` через `request.state.audit_after` (app/core/audit.py), как материалы и события
карточки — свои таблицы модуля появятся вместе с OP-01.
"""

import re
import tempfile
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, TypedDict
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import Select, select

from app.api.foundation.router import require_roles
from app.core.models import AuditLog, User
from app.operator.caller import (
    CALM_KINDS,
    PANIC_MAX,
    PANIC_MIN,
    PANIC_START,
    STEPS,
    CallerState,
    act,
    start_state,
    step_progress,
)
from app.operator.evaluation import TAG_RU, evaluate
from app.operator.review import mark_for
from app.operator.scenarios import load_classifier, load_questionnaires, load_scenarios
from app.operator.switch import require_module_enabled
from app.worker.providers.interfaces import STTProvider
from app.worker.providers.stt.local import LocalFasterWhisperSTT

MAX_KEYS = 50
ATTEMPT_ACTION = "operator_save"
MAX_VOICE_AUDIO_BYTES = 10 * 1024 * 1024
ATTEMPT_ENTITY = "operator_attempt"


MAX_COUNTER = 1000
# Журнал звонка (этап 3): звонок в тренажёре — минуты, событий — десятки; запас — с лихвой.
MAX_JOURNAL_EVENTS = 300
MAX_LINE = 500
MAX_CALL_S = 24 * 3600

Outcome = Literal[
    "correct",
    "early",
    "repeated",
    "irrelevant",
    "not_understood",
    "no_incident",
    "unheard",
    "calming",
    "calmed",
    "order",
    "hold",
    "silence",
    "advice",
    "escalation",
    "confirmed",
    "corrected",
    "unconfirmed",
    "noop",
]


class DialogState(BaseModel):
    panic: int = Field(default=PANIC_START, ge=PANIC_MIN, le=PANIC_MAX)
    asked: list[str] = Field(default_factory=list, max_length=MAX_KEYS)
    facts: list[str] = Field(default_factory=list, max_length=MAX_KEYS)
    pauses: int = Field(default=0, ge=0, le=MAX_COUNTER)
    silence_streak: int = Field(default=0, ge=0, le=MAX_COUNTER)
    unheard: int = Field(default=0, ge=0, le=MAX_COUNTER)
    calm_reason: int = Field(default=0, ge=0, le=MAX_COUNTER)
    calm_order: int = Field(default=0, ge=0, le=MAX_COUNTER)
    escalated: bool = False
    escalation_handled: bool = False
    advice: list[str] = Field(default_factory=list, max_length=MAX_KEYS)
    confirmed: bool = False

    def to_caller(self) -> CallerState:
        return CallerState(
            panic=self.panic,
            asked=tuple(self.asked),
            facts=tuple(self.facts),
            pauses=self.pauses,
            silence_streak=self.silence_streak,
            unheard=self.unheard,
            calm_reason=self.calm_reason,
            calm_order=self.calm_order,
            escalated=self.escalated,
            escalation_handled=self.escalation_handled,
            advice=tuple(self.advice),
            confirmed=self.confirmed,
        )

    @classmethod
    def of(cls, state: CallerState) -> "DialogState":
        return cls(
            panic=state.panic,
            asked=list(state.asked),
            facts=list(state.facts),
            pauses=state.pauses,
            silence_streak=state.silence_streak,
            unheard=state.unheard,
            calm_reason=state.calm_reason,
            calm_order=state.calm_order,
            escalated=state.escalated,
            escalation_handled=state.escalation_handled,
            advice=list(state.advice),
            confirmed=state.confirmed,
        )


class AddressInput(BaseModel):
    city: str = Field(default="", max_length=200)
    okrug: str = Field(default="", max_length=200)
    district: str = Field(default="", max_length=200)
    street: str = Field(default="", max_length=200)
    house: str = Field(default="", max_length=200)
    building: str = Field(default="", max_length=200)
    apartment: str = Field(default="", max_length=200)
    object: str = Field(default="", max_length=200)
    structure: str = Field(default="", max_length=200)
    entrance: str = Field(default="", max_length=200)
    floor: str = Field(default="", max_length=200)
    code: str = Field(default="", max_length=200)
    descriptive: str = Field(default="", max_length=200)


class AskRequest(BaseModel):
    scenario_id: str
    # Нет состояния — начало звонка: паника персонажа из сценария (start_panic).
    state: DialogState | None = None
    action: Literal["question", "calm", "hold", "silence", "advice", "escalate"] = "question"
    text: str | None = Field(default=None, min_length=1, max_length=MAX_LINE)
    questionnaire_id: str | None = None
    key: str | None = None
    # Этап 3: лишний вопрос шага — distractors[].key сценария.
    distractor: str | None = Field(default=None, min_length=1, max_length=40)
    # Этап 3: адрес из карточки — по нему заявитель отвечает на повтор адреса вслух.
    address: AddressInput | None = None
    # calm — reason, soft или order; advice — ключ совета сценария.
    kind: str | None = Field(default=None, min_length=1, max_length=40)

    @model_validator(mode="after")
    def one_question(self) -> "AskRequest":
        if self.action == "question":
            given = [value for value in (self.text, self.key, self.distractor) if value is not None]
            if len(given) != 1:
                raise ValueError(
                    "Нужен ровно один вопрос: text, key (с questionnaire_id) или distractor."
                )
            if self.key is not None and self.questionnaire_id is None:
                raise ValueError("Для key нужен questionnaire_id.")
        elif self.action == "calm" and self.kind not in CALM_KINDS:
            raise ValueError("Для calm нужен kind: reason, soft или order.")
        elif self.action == "advice" and self.kind is None:
            raise ValueError("Для advice нужен kind — ключ совета.")
        return self


class MarkOut(BaseModel):
    """Пометка для разбора звонка: помогло, навредило, внимание, событие (review.py)."""

    kind: Literal["good", "bad", "warn", "info"]
    text: str = Field(min_length=1, max_length=MAX_LINE)


class Reply(BaseModel):
    outcome: Outcome
    text: str
    question_key: str | None
    variant: Literal["calm", "panic"] | None
    # Голосовой файл реплики: «<сценарий>/<реплика>» (contracts/operator/voice.md).
    voice: str | None = None
    mark: MarkOut | None = None


class ProgressOut(BaseModel):
    """Шаги опроса после действия: текущий и пройденные (contracts/operator/dialog.md)."""

    step: int
    done: list[int]


class AskResponse(BaseModel):
    state: DialogState
    reply: Reply
    progress: ProgressOut


class CardInput(BaseModel):
    incident_type_code: str | None = None
    tags: list[str] = Field(default_factory=list, max_length=10)
    services: list[str] = Field(default_factory=list, max_length=30)
    address: AddressInput = Field(default_factory=AddressInput)
    description: str = Field(default="", max_length=1999)
    caller_name: str = Field(default="", max_length=200)
    caller_status: Literal[
        "", "очевидец", "пострадавший", "родственник", "знакомый", "ребенок", "участник"
    ] = ""
    phone_provided: str = Field(default="", max_length=20)
    phone_scene: str = Field(default="", max_length=20)
    off_site: bool = False
    # Признак ЧС карточки 112 (card.schema.json `emergency`); на экране оператора отметки
    # пока нет — по умолчанию нет ЧС, запись оператора-бота может его поставить (DT-04).
    emergency: bool = False

    @field_validator("phone_provided", "phone_scene")
    @classmethod
    def normalized_phone(cls, value: str) -> str:
        # Маска АРМ «+7 (___) ___-__-__»: десять цифр, «+7», «7» или «8» перед ними — код страны.
        if not value.strip():
            return ""
        digits = re.sub(r"[^0-9]", "", value)
        if len(digits) == 11 and digits[0] in "78":
            digits = digits[1:]
        if re.search(r"[^0-9+()\s-]", value) or len(digits) != 10:
            raise ValueError("Укажите телефон: 10 цифр после +7.")
        return "+7" + digits


class JournalEvent(BaseModel):
    """Событие журнала звонка (этап 3, contracts/operator/evaluation.md): действие оператора
    и ответ заявителя, первая реплика или конец разговора."""

    t: int = Field(ge=0, le=MAX_CALL_S)
    action: Literal[
        "opening",
        "question",
        "calm",
        "hold",
        "silence",
        "advice",
        "escalate",
        "senior_called",
        "end",
    ]
    key: str | None = Field(default=None, max_length=40)
    said: str | None = Field(default=None, max_length=MAX_LINE)
    reply: str | None = Field(default=None, max_length=MAX_LINE)
    voice: str | None = Field(default=None, max_length=120)
    note: str | None = Field(default=None, max_length=MAX_LINE)
    outcome: Outcome | None = None
    panic_before: int | None = Field(default=None, ge=PANIC_MIN, le=PANIC_MAX)
    panic_after: int | None = Field(default=None, ge=PANIC_MIN, le=PANIC_MAX)
    mark: MarkOut | None = None


class StepTime(BaseModel):
    """Шаг опроса пройден в секунду `t` звонка."""

    step: int = Field(ge=STEPS[0], le=STEPS[-1])
    t: int = Field(ge=0, le=MAX_CALL_S)


class CallJournal(BaseModel):
    """Журнал звонка для разбора: его ведёт экран, сервер проверяет и хранит в попытке."""

    events: list[JournalEvent] = Field(default_factory=list, max_length=MAX_JOURNAL_EVENTS)
    steps: list[StepTime] = Field(default_factory=list, max_length=len(STEPS))

    @model_validator(mode="after")
    def consistent(self) -> "CallJournal":
        times = [event.t for event in self.events]
        if times != sorted(times):
            raise ValueError("События журнала должны идти по времени.")
        steps = [item.step for item in self.steps]
        if len(steps) != len(set(steps)):
            raise ValueError("Шаг опроса в журнале повторяется.")
        return self


class SaveRequest(BaseModel):
    scenario_id: str
    state: DialogState = Field(default_factory=DialogState)
    elapsed_s: int = Field(ge=0, le=MAX_CALL_S)
    card: CardInput
    journal: CallJournal = Field(default_factory=CallJournal)


class CriterionOut(BaseModel):
    key: str
    title: str
    weight: int
    score: float
    points: int
    explanation: str


class AttemptSummary(BaseModel):
    id: str
    scenario_id: str
    scenario_title: str
    created_at: datetime
    total: int
    max_total: int
    actor_id: str = ""
    actor_login: str = ""
    actor_name: str = ""


class AttemptResult(AttemptSummary):
    criteria: list[CriterionOut]
    operator_card: CardInput | None = None
    # Этап 3: журнал звонка для разбора; у попыток до этапа 3 — пустой.
    journal: CallJournal = Field(default_factory=CallJournal)


def _incident_type_name(code: str | None) -> str:
    if code is None:
        return ""
    for row in load_classifier()["incident_types"]:
        if row["code"] == code:
            return str(row["name"])
    return code


def card_for_dispatch(
    scenario: dict[str, Any], card: CardInput, source_id: str
) -> dict[str, Any] | None:
    """Карточка 112 для служб в формате contracts/card.schema.json (contracts/link-112-dds.md).

    Всё, кроме АОН, — из ввода оператора: диспетчер работает с карточкой такой, как её
    заполнил оператор. АОН оператор не вводит — его даёт сценарий. Телефоны уже приведены
    к `+7XXXXXXXXXX` маской ввода (`CardInput.normalized_phone`). Номер карточки — из id
    попытки или передачи (`source_id`), один для всех служб. Без типа происшествия карточки нет.
    """
    if card.incident_type_code is None:
        return None
    number = str(10_000_000 + int(source_id.replace("-", "")[:12], 16) % 90_000_000)
    return {
        "number": number,
        "incident_type_code": card.incident_type_code,
        # Пустое имя остаётся пустым: имя из сюжета — правда, которой оператор не записал.
        "caller_name": card.caller_name,
        "caller_status": card.caller_status,
        "phone_aon": scenario["caller"]["phone"],
        "phone_provided": card.phone_provided,
        "phone_scene": card.phone_scene,
        "address": card.address.model_dump(),
        "description": card.description,
        "tags": [TAG_RU.get(tag, tag) for tag in card.tags],
        "victims": "victims" in card.tags,
        "ambulance_refused": card.off_site,
        "blocked_people": "no_access" in card.tags,
        "emergency": card.emergency,
        "incident_class": _incident_type_name(card.incident_type_code),
        "service_ids": card.services,
    }


router = APIRouter(
    prefix="/api/operator",
    include_in_schema=False,
    dependencies=[
        Depends(require_roles("trainee", "teacher", "admin")),
        Depends(require_module_enabled),
    ],
)


class OperatorConfig(BaseModel):
    stt_enabled: bool


class TranscribeResult(BaseModel):
    text: str


def _stt_provider(request: Request) -> STTProvider | None:
    """Тесты подставляют поддельного провайдера через request.app.state, минуя очередь
    задач worker'а: у разговора с заявителем нет своего `call_id` в `calls` (OP-01)."""
    override = getattr(request.app.state, "operator_stt_provider", None)
    if override is not None:
        return override
    config = request.app.state.config
    if config.stt_provider != "local":
        return None
    return LocalFasterWhisperSTT(
        base_url=config.stt_base_url, timeout_seconds=config.stt_timeout_seconds
    )


@router.get("/config", operation_id="operator_config")
async def get_config(request: Request) -> OperatorConfig:
    return OperatorConfig(stt_enabled=_stt_provider(request) is not None)


@router.post("/transcribe", operation_id="operator_transcribe")
async def transcribe_question(request: Request, audio: UploadFile) -> TranscribeResult:
    provider = _stt_provider(request)
    if provider is None:
        raise HTTPException(404, "Распознавание речи отключено.")
    suffix = Path(audio.filename or "").suffix or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix) as handle:
        total = 0
        while chunk := await audio.read(1024 * 1024):
            total += len(chunk)
            if total > MAX_VOICE_AUDIO_BYTES:
                raise HTTPException(413, "Аудиофайл превышает 10 МиБ.")
            handle.write(chunk)
        await audio.close()
        if total == 0:
            raise HTTPException(422, "Аудиофайл пуст.")
        handle.flush()
        text = await provider.transcribe(Path(handle.name))
    return TranscribeResult(text=text)


@router.post("/ask")
async def ask_caller(body: AskRequest) -> AskResponse:
    scenario = next((s for s in load_scenarios() if s["id"] == body.scenario_id), None)
    if scenario is None:
        raise HTTPException(404, "Сценарий не найден.")
    text, key = body.text, body.key
    if body.action == "question" and key is not None:
        card = load_questionnaires().get(body.questionnaire_id or "")
        question = next((q for q in (card or {}).get("questions", []) if q["key"] == key), None)
        if question is None:
            raise HTTPException(422, "Такого вопроса нет в опросной карте.")
        if body.questionnaire_id != scenario["questionnaire_id"]:
            # Подсказка из карты другого типа — для заявителя это обычный вопрос словами.
            text, key = question["text"], None
    state = body.state.to_caller() if body.state is not None else start_state(scenario)
    try:
        next_state, reply = act(
            scenario,
            state,
            body.action,
            text=text,
            key=key,
            kind=body.kind,
            distractor=body.distractor,
            address=body.address.model_dump() if body.address else None,
        )
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    mark = mark_for(body.action, state, next_state, reply)
    progress = step_progress(scenario, next_state)
    return AskResponse(
        state=DialogState.of(next_state),
        reply=Reply(
            outcome=reply.outcome,
            text=reply.text,
            question_key=reply.question_key,
            variant=reply.variant,
            voice=f"{scenario['id']}/{reply.line}" if reply.line else None,
            mark=MarkOut(kind=mark.kind, text=mark.text) if mark else None,
        ),
        progress=ProgressOut(step=progress.step, done=list(progress.done)),
    )


@router.post("/save", operation_id=ATTEMPT_ACTION)
async def save_attempt(request: Request, body: SaveRequest) -> AttemptResult:
    scenario = next((s for s in load_scenarios() if s["id"] == body.scenario_id), None)
    if scenario is None:
        raise HTTPException(404, "Сценарий не найден.")
    result = evaluate(
        scenario,
        incident_type_code=body.card.incident_type_code,
        tags=body.card.tags,
        services=body.card.services,
        address=body.card.address.model_dump(),
        description=body.card.description,
        elapsed_s=body.elapsed_s,
        caller=body.state.to_caller(),
        caller_status=body.card.caller_status,
    )
    attempt_id = str(uuid4())
    criteria = [CriterionOut(**asdict(criterion)) for criterion in result.criteria]
    created_at = datetime.now(UTC)
    payload = {
        "scenario_id": scenario["id"],
        "scenario_title": scenario["title"],
        "total": result.total,
        "max_total": result.max_total,
        "criteria": [criterion.model_dump() for criterion in criteria],
        "card": card_for_dispatch(scenario, body.card, attempt_id),
        "operator_card": body.card.model_dump(),
        "dialog_state": body.state.model_dump(),
        "elapsed_s": body.elapsed_s,
        # Этап 3: журнал звонка — для разбора в окне результата и для преподавателя.
        "journal": body.journal.model_dump(exclude_none=True),
    }
    request.state.entity = ATTEMPT_ENTITY
    request.state.entity_id = attempt_id
    request.state.audit_after = payload
    return AttemptResult(
        id=attempt_id,
        scenario_id=scenario["id"],
        scenario_title=scenario["title"],
        created_at=created_at,
        total=result.total,
        max_total=result.max_total,
        criteria=criteria,
        operator_card=body.card,
        journal=body.journal,
        **_attempt_owner(request.state.user),
    )


class AttemptOwner(TypedDict):
    actor_id: str
    actor_login: str
    actor_name: str


def _attempt_owner(user: User) -> AttemptOwner:
    return {"actor_id": str(user.id), "actor_login": user.login, "actor_name": user.full_name}


def _attempt_query(request: Request) -> Select[tuple[AuditLog, User]]:
    """Обучаемый видит только себя; преподаватель и администратор проверяют группу."""
    statement = (
        select(AuditLog, User)
        .join(User, AuditLog.actor_id == User.id)
        .where(AuditLog.action == ATTEMPT_ACTION, AuditLog.entity == ATTEMPT_ENTITY)
    )
    if request.state.user.role == "trainee":
        statement = statement.where(AuditLog.actor_id == request.state.actor_id)
    return statement


@router.get("/attempts", operation_id="operator_attempts")
async def list_attempts(request: Request, trainee_id: UUID | None = None) -> list[AttemptSummary]:
    statement = _attempt_query(request)
    if trainee_id is not None:
        statement = statement.where(AuditLog.actor_id == trainee_id)
    rows = (await request.state.db.execute(statement.order_by(AuditLog.ts.desc()))).all()
    return [
        AttemptSummary(
            id=row.entity_id or "",
            scenario_id=row.after["scenario_id"],
            scenario_title=row.after["scenario_title"],
            created_at=row.ts,
            total=row.after["total"],
            max_total=row.after["max_total"],
            **_attempt_owner(user),
        )
        for row, user in rows
    ]


@router.get("/attempts/{attempt_id}", operation_id="operator_attempt")
async def get_attempt(request: Request, attempt_id: str) -> AttemptResult:
    found = (
        await request.state.db.execute(
            _attempt_query(request).where(AuditLog.entity_id == attempt_id)
        )
    ).first()
    if found is None:
        raise HTTPException(404, "Попытка не найдена.")
    row, user = found
    after = row.after
    return AttemptResult(
        id=attempt_id,
        scenario_id=after["scenario_id"],
        scenario_title=after["scenario_title"],
        created_at=row.ts,
        total=after["total"],
        max_total=after["max_total"],
        criteria=[CriterionOut(**criterion) for criterion in after["criteria"]],
        operator_card=CardInput.model_validate(after["operator_card"])
        if after.get("operator_card") is not None
        else None,
        journal=CallJournal.model_validate(after.get("journal", {})),
        **_attempt_owner(user),
    )
