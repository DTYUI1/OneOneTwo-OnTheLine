"""Модель PostgreSQL по contracts/db_schema.md; изменения только через Alembic."""

from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

# Голова Alembic, которую ждёт этот код: health сообщает об ошибке при другой ревизии БД.
SCHEMA_REVISION = "0015"


class Base(DeclarativeBase):
    type_annotation_map = {
        dict[str, Any]: JSONB,
        list[Any]: JSONB,
        datetime: DateTime(timezone=True),
    }


class Identified:
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)


class Created:
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class Service(Base):
    __tablename__ = "services"
    __table_args__ = (CheckConstraint("phone_ext ~ '^[0-9]{3}$'"),)
    id: Mapped[str] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(unique=True)
    name: Mapped[str]
    phone_ext: Mapped[str] = mapped_column(unique=True)
    voice_profile: Mapped[str]
    category: Mapped[str]
    is_active: Mapped[bool] = mapped_column(default=True)


class Workstation(Base):
    __tablename__ = "workstations"
    __table_args__ = (CheckConstraint("number BETWEEN 1 AND 23"),)
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=False)
    number: Mapped[int] = mapped_column(unique=True)


class User(Identified, Created, Base):
    __tablename__ = "users"
    __table_args__ = (CheckConstraint("role IN ('trainee', 'teacher', 'admin')"),)
    login: Mapped[str] = mapped_column(unique=True)
    password_hash: Mapped[str]
    role: Mapped[str]
    full_name: Mapped[str]
    is_active: Mapped[bool] = mapped_column(default=True)
    workstation_number: Mapped[int | None] = mapped_column(ForeignKey("workstations.number"))
    dds_service_id: Mapped[str | None] = mapped_column(ForeignKey("services.id"))


class UserDeletion(Base):
    """Корзина C-07: учётка удалена администратором (и заблокирована); purged_at —
    обезличена после резервной копии. Восстановление удаляет строку."""

    __tablename__ = "user_deletions"
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    deleted_at: Mapped[datetime]
    deleted_by: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    reason: Mapped[str]
    purged_at: Mapped[datetime | None]


class AuthSession(Identified, Created, Base):
    __tablename__ = "auth_sessions"
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), index=True)
    csrf_hash: Mapped[str]
    expires_at: Mapped[datetime] = mapped_column(index=True)


class IncidentType(Base):
    __tablename__ = "incident_types"
    code: Mapped[str] = mapped_column(primary_key=True)
    group_no: Mapped[str]
    group_name: Mapped[str]
    name: Mapped[str]
    sign1: Mapped[str]
    sign2: Mapped[str]
    sign3: Mapped[str]
    scenario_code: Mapped[str]
    main_service_code: Mapped[str]
    raw: Mapped[dict[str, Any]]


class RoutingRule(Identified, Base):
    __tablename__ = "routing_rules"
    incident_type_code: Mapped[str] = mapped_column(ForeignKey("incident_types.code"))
    service_id: Mapped[str] = mapped_column(ForeignKey("services.id"))
    condition: Mapped[dict[str, Any]]
    payload: Mapped[str]


class Street(Identified, Base):
    __tablename__ = "streets"
    name: Mapped[str]
    name_norm: Mapped[str] = mapped_column(index=True)
    okrug: Mapped[str]
    district: Mapped[str]
    source: Mapped[str]


class Scenario(Identified, Created, Base):
    __tablename__ = "scenarios"
    __table_args__ = (
        CheckConstraint("level BETWEEN 1 AND 4"),
        CheckConstraint("weight BETWEEN 1 AND 10"),
        CheckConstraint("status IN ('draft', 'approved', 'retired')"),
    )
    version: Mapped[int]
    level: Mapped[int]
    weight: Mapped[int]
    incident_type_code: Mapped[str] = mapped_column(ForeignKey("incident_types.code"))
    target_service_id: Mapped[str] = mapped_column(ForeignKey("services.id"))
    card: Mapped[dict[str, Any]]
    reference: Mapped[dict[str, Any]]
    complications: Mapped[list[Any]]
    origin: Mapped[str]
    status: Mapped[str]
    author_id: Mapped[UUID | None] = mapped_column(ForeignKey("users.id"))
    teacher_comment: Mapped[str]


class ScenarioPack(Identified, Base):
    __tablename__ = "scenario_packs"
    __table_args__ = (CheckConstraint("status IN ('draft', 'approved', 'retired')"),)
    title: Mapped[str]
    status: Mapped[str]
    origin: Mapped[str]
    created_by: Mapped[UUID | None] = mapped_column(ForeignKey("users.id"))


class ScenarioPackItem(Base):
    __tablename__ = "scenario_pack_items"
    __table_args__ = (UniqueConstraint("pack_id", "order"),)
    pack_id: Mapped[UUID] = mapped_column(ForeignKey("scenario_packs.id"), primary_key=True)
    scenario_id: Mapped[UUID] = mapped_column(ForeignKey("scenarios.id"), primary_key=True)
    order: Mapped[int]


class Session(Identified, Base):
    __tablename__ = "sessions"
    __table_args__ = (
        CheckConstraint("status IN ('draft', 'running', 'finished')"),
        CheckConstraint("kind IN ('lesson', 'practice')", name="ck_sessions_kind"),
    )
    # У тренировки (kind="practice") владелец — сам обучаемый: преподаватели её не видят.
    teacher_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    title: Mapped[str]
    status: Mapped[str]
    kind: Mapped[str] = mapped_column(default="lesson", server_default="lesson")
    started_at: Mapped[datetime | None]
    finished_at: Mapped[datetime | None]
    settings_snapshot: Mapped[dict[str, Any]]
    # Снимок I-TIME (contracts/c01.schema.json#TimingPolicy); NULL — legacy v1 старых занятий.
    timing_policy: Mapped[dict[str, Any] | None]
    participants: Mapped[list["Participant"]] = relationship(lazy="raise")


class Participant(Identified, Base):
    __tablename__ = "session_participants"
    __table_args__ = (
        UniqueConstraint("session_id", "user_id"),
        UniqueConstraint("session_id", "workstation_id"),
        UniqueConstraint("session_id", "id"),
        CheckConstraint("level BETWEEN 1 AND 4"),
    )
    session_id: Mapped[UUID] = mapped_column(ForeignKey("sessions.id"))
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    workstation_id: Mapped[int] = mapped_column(ForeignKey("workstations.id"))
    dds_service_id: Mapped[str] = mapped_column(ForeignKey("services.id"))
    level: Mapped[int]
    rating_at_start: Mapped[float]


class Assignment(Identified, Base):
    __tablename__ = "assignments"
    __table_args__ = (
        UniqueConstraint("participant_id", "order"),
        CheckConstraint('"order" >= 1'),
        CheckConstraint("status IN ('pending', 'delivered', 'completed', 'cancelled')"),
        CheckConstraint("delay_from_start_s BETWEEN 0 AND 86400"),
    )
    session_id: Mapped[UUID] = mapped_column(ForeignKey("sessions.id"))
    participant_id: Mapped[UUID] = mapped_column(ForeignKey("session_participants.id"))
    scenario_id: Mapped[UUID] = mapped_column(ForeignKey("scenarios.id"))
    order: Mapped[int]
    planned_at: Mapped[datetime | None]
    status: Mapped[str]
    batch_id: Mapped[UUID | None] = mapped_column(ForeignKey("assignment_batches.id"))
    scenario_version: Mapped[int | None]
    delay_from_start_s: Mapped[int | None]
    delivery_mode: Mapped[str | None]
    due_at: Mapped[datetime | None]
    cancelled_at: Mapped[datetime | None]


class AssignmentBatch(Identified, Created, Base):
    __tablename__ = "assignment_batches"
    __table_args__ = (UniqueConstraint("teacher_id", "session_id", "request_id"),)
    teacher_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    session_id: Mapped[UUID] = mapped_column(ForeignKey("sessions.id"))
    request_id: Mapped[UUID]
    canonical_request: Mapped[str]
    receipt: Mapped[dict[str, Any]]


class SessionFinish(Identified, Base):
    __tablename__ = "session_finishes"
    session_id: Mapped[UUID] = mapped_column(ForeignKey("sessions.id"), unique=True)
    teacher_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    request_id: Mapped[UUID | None]
    receipt: Mapped[dict[str, Any]]


class Card(Identified, Base):
    __tablename__ = "cards"
    __table_args__ = (
        CheckConstraint(
            "state IN ('added','received','accepted','rejected','responding',"
            "'arrived','working','refused','completed','redirected')",
            name="cards_state_check",
        ),
        CheckConstraint("number ~ '^[0-9]{8}$'"),
    )
    assignment_id: Mapped[UUID] = mapped_column(
        ForeignKey("assignments.id"), index=True, unique=True
    )
    number: Mapped[str]
    state: Mapped[str]
    appeared_at: Mapped[datetime]
    delivered_at: Mapped[datetime | None]
    opened_at: Mapped[datetime | None]
    first_status_at: Mapped[datetime | None]
    closed_at: Mapped[datetime | None]
    interrupted_at: Mapped[datetime | None]
    current: Mapped[dict[str, Any]]
    redirected_to_service_id: Mapped[str | None] = mapped_column(ForeignKey("services.id"))


class CardEvent(Identified, Base):
    __tablename__ = "card_events"
    __table_args__ = (
        UniqueConstraint("actor_id", "client_event_id"),
        Index("ix_card_events_card_time", "card_id", "server_ts"),
    )
    card_id: Mapped[UUID] = mapped_column(ForeignKey("cards.id"))
    actor_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    client_event_id: Mapped[UUID]
    client_ts: Mapped[datetime]
    server_ts: Mapped[datetime] = mapped_column(server_default=func.now())
    clock_offset_ms: Mapped[float]
    type: Mapped[str]
    payload: Mapped[dict[str, Any]]
    # Проверенный образец часов v2 (C-02); у старых событий и без синхронизации — NULL.
    clock_sample_id: Mapped[UUID | None] = mapped_column(ForeignKey("clock_samples.id"))


class ClockSample(Base):
    """Образец часов ws_midpoint_v2: pong сервера и подтверждение клиента (I-TIME)."""

    __tablename__ = "clock_samples"
    id: Mapped[UUID] = mapped_column(primary_key=True)
    actor_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), index=True)
    client_sent_at: Mapped[datetime]
    server_at: Mapped[datetime]
    client_received_at: Mapped[datetime | None]
    offset_ms: Mapped[float | None]
    confirmed_at: Mapped[datetime | None]


class Material(Base):
    """Неизменяемая версия учебного материала преподавателя (C-07, I-CONTENT)."""

    __tablename__ = "materials"
    __table_args__ = (
        CheckConstraint("purpose IN ('reference', 'evaluation')"),
        CheckConstraint("size_bytes BETWEEN 1 AND 10485760"),
    )
    id: Mapped[UUID] = mapped_column(primary_key=True)
    version: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), index=True)
    title: Mapped[str]
    purpose: Mapped[str]
    media_type: Mapped[str]
    size_bytes: Mapped[int]
    sha256: Mapped[str]
    relative_path: Mapped[str]
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class SessionMaterial(Base):
    """Назначение точной версии справочного материала занятию."""

    __tablename__ = "session_materials"
    session_id: Mapped[UUID] = mapped_column(ForeignKey("sessions.id"), primary_key=True)
    material_id: Mapped[UUID] = mapped_column(primary_key=True)
    version: Mapped[int] = mapped_column(primary_key=True)
    __table_args__ = (
        ForeignKeyConstraint(["material_id", "version"], ["materials.id", "materials.version"]),
    )


class MaterialAssignmentReceipt(Base):
    """Повтор назначения по request_id возвращает прежний ответ (идемпотентность)."""

    __tablename__ = "material_assignment_receipts"
    actor_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    request_id: Mapped[UUID] = mapped_column(primary_key=True)
    session_id: Mapped[UUID] = mapped_column(ForeignKey("sessions.id"))
    body: Mapped[dict[str, Any]]
    response: Mapped[list[Any]]


class OperationReceipt(Base):
    """Квитанция идемпотентной операции: повтор request_id с тем же телом — тот же ответ."""

    __tablename__ = "operation_receipts"
    actor_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    operation: Mapped[str] = mapped_column(primary_key=True)
    request_id: Mapped[UUID] = mapped_column(primary_key=True)
    body: Mapped[dict[str, Any]]
    response: Mapped[dict[str, Any]]


class CardEventReceipt(Base):
    __tablename__ = "card_event_receipts"
    event_id: Mapped[UUID] = mapped_column(ForeignKey("card_events.id"), primary_key=True)
    receipt: Mapped[dict[str, Any]]


class Call(Identified, Base):
    __tablename__ = "calls"
    __table_args__ = (
        CheckConstraint("dialed_ext ~ '^[0-9]{3}$'"),
        CheckConstraint("direction IN ('outbound', 'inbound')", name="ck_calls_direction"),
        CheckConstraint(
            "refusal IS NULL OR refusal IN ('busy', 'not_assigned')", name="ck_calls_refusal"
        ),
    )
    card_id: Mapped[UUID] = mapped_column(ForeignKey("cards.id"))
    dialed_ext: Mapped[str]
    service_id: Mapped[str | None] = mapped_column(ForeignKey("services.id"))
    started_at: Mapped[datetime]
    answered_at: Mapped[datetime | None]
    ended_at: Mapped[datetime | None]
    end_reason: Mapped[str | None]
    target_id: Mapped[UUID | None] = mapped_column(ForeignKey("call_targets.id"))
    brigade_id: Mapped[UUID | None] = mapped_column(ForeignKey("brigades.id"))
    audio_path: Mapped[str | None]
    transcript: Mapped[str | None]
    # inbound — бригада звонит диспетчеру сама с готовым докладом (решение 27.09).
    direction: Mapped[str] = mapped_column(default="outbound", server_default="outbound")
    # Бригада не направлена на это происшествие (busy — занята на другом, not_assigned —
    # вызов ей не назначен): она отвечает отказом и не докладывает по этому звонку (0013).
    refusal: Mapped[str | None]


class Prediction(Identified, Base):
    __tablename__ = "predictions"
    __table_args__ = (
        UniqueConstraint("card_id"),
        CheckConstraint(
            "p_success BETWEEN 0 AND 1 AND expected_score BETWEEN 0 AND 1 "
            "AND p_timeout BETWEEN 0 AND 1"
        ),
        CheckConstraint("actual_score BETWEEN 0 AND 1"),
        CheckConstraint("expected_time_s >= 0 AND (actual_time_s IS NULL OR actual_time_s >= 0)"),
        Index("ix_predictions_participant_time", "participant_id", "made_at"),
    )
    card_id: Mapped[UUID] = mapped_column(ForeignKey("cards.id"))
    participant_id: Mapped[UUID] = mapped_column(ForeignKey("session_participants.id"))
    made_at: Mapped[datetime] = mapped_column(server_default=func.now())
    p_success: Mapped[float]
    expected_score: Mapped[float]
    p_timeout: Mapped[float]
    expected_time_s: Mapped[float]
    theta_before: Mapped[float]
    b_scenario: Mapped[float]
    model_version: Mapped[str]
    actual_score: Mapped[float | None]
    actual_time_s: Mapped[float | None]
    actual_timeout: Mapped[bool | None]


class Evaluation(Identified, Created, Base):
    __tablename__ = "evaluations"
    __table_args__ = (
        UniqueConstraint("card_id", "version"),
        CheckConstraint("total BETWEEN 0 AND 1"),
        CheckConstraint("status IN ('partial', 'complete')"),
    )
    card_id: Mapped[UUID] = mapped_column(ForeignKey("cards.id"))
    version: Mapped[int]
    rules_scores: Mapped[dict[str, Any]]
    semantic_scores: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    llm_scores: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    total: Mapped[float]
    critical_flags: Mapped[list[Any]]
    explanation: Mapped[dict[str, Any]]
    model_info: Mapped[dict[str, Any]]
    status: Mapped[str]


class TeacherOverride(Identified, Created, Base):
    __tablename__ = "teacher_overrides"
    __table_args__ = (
        CheckConstraint("decision IN ('agree', 'disagree')"),
        CheckConstraint("new_total BETWEEN 0 AND 1"),
    )
    evaluation_id: Mapped[UUID] = mapped_column(ForeignKey("evaluations.id"))
    teacher_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    decision: Mapped[str]
    new_total: Mapped[float | None]
    criterion_patches: Mapped[dict[str, Any]]
    reason: Mapped[str]
    teacher_comment: Mapped[str]


class TraineeRating(Base):
    __tablename__ = "trainee_ratings"
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    theta: Mapped[float]
    theta_var: Mapped[float]
    history: Mapped[list[Any]]


class Setting(Base):
    __tablename__ = "settings"
    key: Mapped[str] = mapped_column(primary_key=True)
    value: Mapped[dict[str, Any]]
    updated_by: Mapped[UUID | None] = mapped_column(ForeignKey("users.id"))
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now())


class AuditLog(Identified, Base):
    __tablename__ = "audit_log"
    ts: Mapped[datetime] = mapped_column(server_default=func.now(), index=True)
    actor_id: Mapped[UUID | None] = mapped_column(ForeignKey("users.id"))
    action: Mapped[str]
    entity: Mapped[str]
    entity_id: Mapped[str | None]
    before: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    after: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    ip: Mapped[str | None]


class Job(Identified, Base):
    __tablename__ = "jobs"
    __table_args__ = (
        CheckConstraint("status IN ('pending', 'running', 'done', 'failed')"),
        CheckConstraint("kind IN ('generate', 'evaluate', 'insights', 'transcribe', 'tts')"),
        CheckConstraint("attempts >= 0"),
        Index("ix_jobs_status_run_after", "status", "run_after"),
    )
    kind: Mapped[str]
    payload: Mapped[dict[str, Any]]
    status: Mapped[str]
    attempts: Mapped[int] = mapped_column(default=0)
    locked_by: Mapped[str | None]
    locked_at: Mapped[datetime | None]
    idempotency_key: Mapped[str | None] = mapped_column(unique=True)
    run_after: Mapped[datetime] = mapped_column(server_default=func.now())
    result: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    error: Mapped[str | None]


class Backup(Base):
    """Резервная копия C-08: строки пишет контейнер backup через psql, запрос — API (C-07)."""

    __tablename__ = "backups"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'running', 'done', 'failed')", name="ck_backups_status"
        ),
        Index("ix_backups_status_started_at", "status", "started_at"),
    )
    id: Mapped[UUID] = mapped_column(
        primary_key=True, default=uuid4, server_default=func.gen_random_uuid()
    )
    status: Mapped[str]
    requested_by: Mapped[UUID | None] = mapped_column(ForeignKey("users.id"))
    requested_at: Mapped[datetime] = mapped_column(server_default=func.now())
    # Время БД до начала pg_dump: всё, что помечено раньше, в копию уже попало.
    started_at: Mapped[datetime | None]
    finished_at: Mapped[datetime | None]
    name: Mapped[str | None]
    error: Mapped[str | None]


class WorkerHeartbeat(Base):
    __tablename__ = "worker_heartbeats"
    worker_id: Mapped[str] = mapped_column(primary_key=True)
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now())


class SeedArtifact(Base):
    __tablename__ = "seed_artifacts"
    path: Mapped[str] = mapped_column(primary_key=True)
    schema_name: Mapped[str]
    content: Mapped[dict[str, Any]]


class Brigade(Identified, Base):
    __tablename__ = "brigades"
    service_id: Mapped[str] = mapped_column(ForeignKey("services.id"))
    name: Mapped[str]
    is_active: Mapped[bool]


class CallTarget(Identified, Base):
    __tablename__ = "call_targets"
    __table_args__ = (CheckConstraint("phone_ext ~ '^[0-9]{3}$'"),)
    service_id: Mapped[str] = mapped_column(ForeignKey("services.id"))
    brigade_id: Mapped[UUID | None] = mapped_column(ForeignKey("brigades.id"))
    name: Mapped[str]
    phone_ext: Mapped[str] = mapped_column(unique=True)
    voice_profile: Mapped[str]
    is_active: Mapped[bool]


class ScenarioTrainingPlan(Base):
    __tablename__ = "scenario_training_plans"
    scenario_id: Mapped[UUID] = mapped_column(ForeignKey("scenarios.id"), primary_key=True)
    scenario_version: Mapped[int] = mapped_column(primary_key=True)
    author_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    plan: Mapped[dict[str, Any]]


class MessageAudioAsset(Base):
    __tablename__ = "message_audio_assets"
    asset_id: Mapped[UUID] = mapped_column(primary_key=True)
    version: Mapped[int] = mapped_column(primary_key=True)
    relative_path: Mapped[str]
    sha256: Mapped[str]
    duration_ms: Mapped[int]
    media_type: Mapped[str]


class CardTrainingState(Base):
    __tablename__ = "card_training_states"
    card_id: Mapped[UUID] = mapped_column(ForeignKey("cards.id"), primary_key=True)
    revision: Mapped[int] = mapped_column(default=1)


class CardBrigade(Base):
    __tablename__ = "card_brigades"
    card_id: Mapped[UUID] = mapped_column(ForeignKey("cards.id"), primary_key=True)
    brigade_id: Mapped[UUID] = mapped_column(ForeignKey("brigades.id"), primary_key=True)


class MessageDelivery(Identified, Base):
    __tablename__ = "message_deliveries"
    __table_args__ = (UniqueConstraint("card_id", "message_id", "message_version"),)
    card_id: Mapped[UUID] = mapped_column(ForeignKey("cards.id"))
    call_id: Mapped[UUID] = mapped_column(ForeignKey("calls.id"))
    participant_id: Mapped[UUID] = mapped_column(ForeignKey("session_participants.id"))
    brigade_id: Mapped[UUID] = mapped_column(ForeignKey("brigades.id"))
    target_id: Mapped[UUID] = mapped_column(ForeignKey("call_targets.id"))
    message_id: Mapped[UUID]
    message_version: Mapped[int]
    delivered_at: Mapped[datetime]
    message: Mapped[dict[str, Any]]
    # Бригада выполняет работу: с отправки или нужного статуса до готовности доклада.
    # Это подтверждённое ожидание; NULL у выдач до 0012.
    waiting_started_at: Mapped[datetime | None]
    ready_at: Mapped[datetime | None]


class MessagePresentation(Identified, Base):
    __tablename__ = "message_presentations"
    __table_args__ = (
        UniqueConstraint("actor_id", "playback_id"),
        CheckConstraint("kind IN ('message_presented', 'message_failed')"),
    )
    delivery_id: Mapped[UUID] = mapped_column(ForeignKey("message_deliveries.id"))
    event_id: Mapped[UUID] = mapped_column(ForeignKey("card_events.id"), unique=True)
    actor_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    playback_id: Mapped[UUID]
    kind: Mapped[str]
    recorded_at: Mapped[datetime]
    payload: Mapped[dict[str, Any]]


class ProblemReport(Identified, Created, Base):
    """Сообщение об ошибке от обучаемого, преподавателя или администратора (28.09).

    Кнопка «Сообщить об ошибке» в шапке; читает администратор. Роль автора и экран
    сохраняются снимком: учётная запись может смениться, а сообщение — нет.
    """

    __tablename__ = "problem_reports"
    __table_args__ = (
        CheckConstraint(
            "category IN ('bug', 'evaluation', 'unclear', 'other')",
            name="ck_problem_reports_category",
        ),
        CheckConstraint("char_length(text) BETWEEN 1 AND 2000", name="ck_problem_reports_text"),
        Index("ix_problem_reports_created_at", "created_at"),
    )
    author_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    author_role: Mapped[str]
    category: Mapped[str]
    text: Mapped[str]
    page: Mapped[str]
