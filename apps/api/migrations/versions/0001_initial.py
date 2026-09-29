"""Создать основу API и защитить неизменяемые журналы."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "incident_types",
        sa.Column("code", sa.String(), nullable=False),
        sa.Column("group_no", sa.String(), nullable=False),
        sa.Column("group_name", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("sign1", sa.String(), nullable=False),
        sa.Column("sign2", sa.String(), nullable=False),
        sa.Column("sign3", sa.String(), nullable=False),
        sa.Column("scenario_code", sa.String(), nullable=False),
        sa.Column("main_service_code", sa.String(), nullable=False),
        sa.Column("raw", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.PrimaryKeyConstraint("code"),
    )
    op.create_table(
        "jobs",
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("locked_by", sa.String(), nullable=True),
        sa.Column(
            "run_after", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("result", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("error", sa.String(), nullable=True),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.CheckConstraint("kind IN ('generate', 'evaluate', 'insights', 'transcribe', 'tts')"),
        sa.CheckConstraint("status IN ('pending', 'running', 'done', 'failed')"),
        sa.CheckConstraint("attempts >= 0"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_jobs_status_run_after", "jobs", ["status", "run_after"], unique=False)
    op.create_table(
        "seed_artifacts",
        sa.Column("path", sa.String(), nullable=False),
        sa.Column("schema_name", sa.String(), nullable=False),
        sa.Column("content", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.PrimaryKeyConstraint("path"),
    )
    op.create_table(
        "services",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("code", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("phone_ext", sa.String(), nullable=False),
        sa.Column("voice_profile", sa.String(), nullable=False),
        sa.Column("category", sa.String(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.CheckConstraint("phone_ext ~ '^[0-9]{3}$'"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("code"),
        sa.UniqueConstraint("phone_ext"),
    )
    op.create_table(
        "streets",
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("name_norm", sa.String(), nullable=False),
        sa.Column("okrug", sa.String(), nullable=False),
        sa.Column("district", sa.String(), nullable=False),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_streets_name_norm"), "streets", ["name_norm"], unique=False)
    op.create_table(
        "workstations",
        sa.Column("id", sa.Integer(), autoincrement=False, nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.CheckConstraint("number BETWEEN 1 AND 23"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("number"),
    )
    op.create_table(
        "routing_rules",
        sa.Column("incident_type_code", sa.String(), nullable=False),
        sa.Column("service_id", sa.String(), nullable=False),
        sa.Column("condition", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("payload", sa.String(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(
            ["incident_type_code"],
            ["incident_types.code"],
        ),
        sa.ForeignKeyConstraint(
            ["service_id"],
            ["services.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "users",
        sa.Column("login", sa.String(), nullable=False),
        sa.Column("password_hash", sa.String(), nullable=False),
        sa.Column("role", sa.String(), nullable=False),
        sa.Column("full_name", sa.String(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("workstation_number", sa.Integer(), nullable=True),
        sa.Column("dds_service_id", sa.String(), nullable=True),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("role IN ('trainee', 'teacher', 'admin')"),
        sa.ForeignKeyConstraint(
            ["dds_service_id"],
            ["services.id"],
        ),
        sa.ForeignKeyConstraint(
            ["workstation_number"],
            ["workstations.number"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("login"),
    )
    op.create_table(
        "audit_log",
        sa.Column(
            "ts", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("actor_id", sa.Uuid(), nullable=True),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("entity", sa.String(), nullable=False),
        sa.Column("entity_id", sa.String(), nullable=True),
        sa.Column("before", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("after", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("ip", sa.String(), nullable=True),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(
            ["actor_id"],
            ["users.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_audit_log_ts"), "audit_log", ["ts"], unique=False)
    op.create_table(
        "auth_sessions",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("csrf_hash", sa.String(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_auth_sessions_expires_at"), "auth_sessions", ["expires_at"], unique=False
    )
    op.create_index(op.f("ix_auth_sessions_user_id"), "auth_sessions", ["user_id"], unique=False)
    op.create_table(
        "scenario_packs",
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("origin", sa.String(), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.CheckConstraint("status IN ('draft', 'approved', 'retired')"),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "scenarios",
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("level", sa.Integer(), nullable=False),
        sa.Column("weight", sa.Integer(), nullable=False),
        sa.Column("incident_type_code", sa.String(), nullable=False),
        sa.Column("target_service_id", sa.String(), nullable=False),
        sa.Column("card", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("reference", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("complications", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("origin", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("author_id", sa.Uuid(), nullable=True),
        sa.Column("teacher_comment", sa.String(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("status IN ('draft', 'approved', 'retired')"),
        sa.CheckConstraint("level BETWEEN 1 AND 4"),
        sa.CheckConstraint("weight BETWEEN 1 AND 10"),
        sa.ForeignKeyConstraint(
            ["author_id"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(
            ["incident_type_code"],
            ["incident_types.code"],
        ),
        sa.ForeignKeyConstraint(
            ["target_service_id"],
            ["services.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "sessions",
        sa.Column("teacher_id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("settings_snapshot", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.CheckConstraint("status IN ('draft', 'running', 'finished')"),
        sa.ForeignKeyConstraint(
            ["teacher_id"],
            ["users.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "settings",
        sa.Column("key", sa.String(), nullable=False),
        sa.Column("value", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("updated_by", sa.Uuid(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["updated_by"],
            ["users.id"],
        ),
        sa.PrimaryKeyConstraint("key"),
    )
    op.create_table(
        "trainee_ratings",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("theta", sa.Float(), nullable=False),
        sa.Column("theta_var", sa.Float(), nullable=False),
        sa.Column("history", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
        ),
        sa.PrimaryKeyConstraint("user_id"),
    )
    op.create_table(
        "scenario_pack_items",
        sa.Column("pack_id", sa.Uuid(), nullable=False),
        sa.Column("scenario_id", sa.Uuid(), nullable=False),
        sa.Column("order", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(
            ["pack_id"],
            ["scenario_packs.id"],
        ),
        sa.ForeignKeyConstraint(
            ["scenario_id"],
            ["scenarios.id"],
        ),
        sa.PrimaryKeyConstraint("pack_id", "scenario_id"),
        sa.UniqueConstraint("pack_id", "order"),
    )
    op.create_table(
        "session_participants",
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("workstation_id", sa.Integer(), nullable=False),
        sa.Column("dds_service_id", sa.String(), nullable=False),
        sa.Column("level", sa.Integer(), nullable=False),
        sa.Column("rating_at_start", sa.Float(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.CheckConstraint("level BETWEEN 1 AND 4"),
        sa.ForeignKeyConstraint(
            ["dds_service_id"],
            ["services.id"],
        ),
        sa.ForeignKeyConstraint(
            ["session_id"],
            ["sessions.id"],
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(
            ["workstation_id"],
            ["workstations.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("session_id", "id"),
        sa.UniqueConstraint("session_id", "user_id"),
        sa.UniqueConstraint("session_id", "workstation_id"),
    )
    op.create_table(
        "assignments",
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("participant_id", sa.Uuid(), nullable=False),
        sa.Column("scenario_id", sa.Uuid(), nullable=False),
        sa.Column("order", sa.Integer(), nullable=False),
        sa.Column("planned_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(
            ["participant_id"],
            ["session_participants.id"],
        ),
        sa.ForeignKeyConstraint(
            ["scenario_id"],
            ["scenarios.id"],
        ),
        sa.ForeignKeyConstraint(
            ["session_id"],
            ["sessions.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "cards",
        sa.Column("assignment_id", sa.Uuid(), nullable=False),
        sa.Column("number", sa.String(), nullable=False),
        sa.Column("state", sa.String(), nullable=False),
        sa.Column("appeared_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("opened_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("first_status_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("current", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("redirected_to_service_id", sa.String(), nullable=True),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.CheckConstraint(
            "state IN ('added','received','accepted','rejected','responding',"
            "'refused','completed','redirected')"
        ),
        sa.ForeignKeyConstraint(
            ["assignment_id"],
            ["assignments.id"],
        ),
        sa.ForeignKeyConstraint(
            ["redirected_to_service_id"],
            ["services.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_cards_assignment_id"), "cards", ["assignment_id"], unique=False)
    op.create_table(
        "calls",
        sa.Column("card_id", sa.Uuid(), nullable=False),
        sa.Column("dialed_ext", sa.String(), nullable=False),
        sa.Column("service_id", sa.String(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("answered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("audio_path", sa.String(), nullable=True),
        sa.Column("transcript", sa.String(), nullable=True),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(
            ["card_id"],
            ["cards.id"],
        ),
        sa.ForeignKeyConstraint(
            ["service_id"],
            ["services.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "card_events",
        sa.Column("card_id", sa.Uuid(), nullable=False),
        sa.Column("actor_id", sa.Uuid(), nullable=False),
        sa.Column("client_event_id", sa.Uuid(), nullable=False),
        sa.Column("client_ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "server_ts", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("clock_offset_ms", sa.Float(), nullable=False),
        sa.Column("type", sa.String(), nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(
            ["actor_id"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(
            ["card_id"],
            ["cards.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("actor_id", "client_event_id"),
    )
    op.create_index(
        "ix_card_events_card_time", "card_events", ["card_id", "server_ts"], unique=False
    )
    op.create_table(
        "evaluations",
        sa.Column("card_id", sa.Uuid(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("rules_scores", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("semantic_scores", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("llm_scores", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("total", sa.Float(), nullable=False),
        sa.Column("critical_flags", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("explanation", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("model_info", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("status IN ('partial', 'complete')"),
        sa.CheckConstraint("total BETWEEN 0 AND 1"),
        sa.ForeignKeyConstraint(
            ["card_id"],
            ["cards.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("card_id", "version"),
    )
    op.create_table(
        "predictions",
        sa.Column("card_id", sa.Uuid(), nullable=False),
        sa.Column("participant_id", sa.Uuid(), nullable=False),
        sa.Column(
            "made_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("p_success", sa.Float(), nullable=False),
        sa.Column("expected_score", sa.Float(), nullable=False),
        sa.Column("p_timeout", sa.Float(), nullable=False),
        sa.Column("expected_time_s", sa.Float(), nullable=False),
        sa.Column("theta_before", sa.Float(), nullable=False),
        sa.Column("b_scenario", sa.Float(), nullable=False),
        sa.Column("model_version", sa.String(), nullable=False),
        sa.Column("actual_score", sa.Float(), nullable=True),
        sa.Column("actual_time_s", sa.Float(), nullable=True),
        sa.Column("actual_timeout", sa.Boolean(), nullable=True),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.CheckConstraint("actual_score BETWEEN 0 AND 1"),
        sa.CheckConstraint(
            "expected_time_s >= 0 AND (actual_time_s IS NULL OR actual_time_s >= 0)"
        ),
        sa.CheckConstraint(
            "p_success BETWEEN 0 AND 1 AND expected_score BETWEEN 0 AND 1 "
            "AND p_timeout BETWEEN 0 AND 1"
        ),
        sa.ForeignKeyConstraint(
            ["card_id"],
            ["cards.id"],
        ),
        sa.ForeignKeyConstraint(
            ["participant_id"],
            ["session_participants.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_predictions_participant_time",
        "predictions",
        ["participant_id", "made_at"],
        unique=False,
    )
    op.create_table(
        "teacher_overrides",
        sa.Column("evaluation_id", sa.Uuid(), nullable=False),
        sa.Column("teacher_id", sa.Uuid(), nullable=False),
        sa.Column("decision", sa.String(), nullable=False),
        sa.Column("new_total", sa.Float(), nullable=True),
        sa.Column("criterion_patches", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("reason", sa.String(), nullable=False),
        sa.Column("teacher_comment", sa.String(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("decision IN ('agree', 'disagree')"),
        sa.CheckConstraint("new_total BETWEEN 0 AND 1"),
        sa.ForeignKeyConstraint(
            ["evaluation_id"],
            ["evaluations.id"],
        ),
        sa.ForeignKeyConstraint(
            ["teacher_id"],
            ["users.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.execute("""
        CREATE FUNCTION reject_journal_change() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'append-only journal: %', TG_TABLE_NAME;
        END $$
    """)
    for table in ("card_events", "audit_log", "teacher_overrides"):
        op.execute(
            f"CREATE TRIGGER immutable_journal BEFORE UPDATE OR DELETE ON {table} "
            "FOR EACH ROW EXECUTE FUNCTION reject_journal_change()"
        )
        op.execute(
            f"CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON {table} "
            "FOR EACH STATEMENT EXECUTE FUNCTION reject_journal_change()"
        )
    op.execute("""
        CREATE FUNCTION protect_prediction() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF TG_OP <> 'UPDATE' THEN
                RAISE EXCEPTION 'append-only prediction';
            END IF;
            IF (to_jsonb(NEW) - ARRAY['actual_score','actual_time_s','actual_timeout'])
               IS DISTINCT FROM
               (to_jsonb(OLD) - ARRAY['actual_score','actual_time_s','actual_timeout'])
               OR (OLD.actual_score IS NOT NULL
                   AND NEW.actual_score IS DISTINCT FROM OLD.actual_score)
               OR (OLD.actual_time_s IS NOT NULL
                   AND NEW.actual_time_s IS DISTINCT FROM OLD.actual_time_s)
               OR (OLD.actual_timeout IS NOT NULL
                   AND NEW.actual_timeout IS DISTINCT FROM OLD.actual_timeout) THEN
                RAISE EXCEPTION 'immutable prediction or recorded outcome';
            END IF;
            RETURN NEW;
        END $$
    """)
    op.execute(
        "CREATE TRIGGER immutable_prediction BEFORE UPDATE OR DELETE ON predictions "
        "FOR EACH ROW EXECUTE FUNCTION protect_prediction()"
    )
    op.execute(
        "CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON predictions "
        "FOR EACH STATEMENT EXECUTE FUNCTION reject_journal_change()"
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER immutable_prediction ON predictions")
    op.execute("DROP FUNCTION protect_prediction()")
    op.drop_table("teacher_overrides")
    op.drop_index("ix_predictions_participant_time", table_name="predictions")
    op.drop_table("predictions")
    op.drop_table("evaluations")
    op.drop_index("ix_card_events_card_time", table_name="card_events")
    op.drop_table("card_events")
    op.drop_table("calls")
    op.drop_index(op.f("ix_cards_assignment_id"), table_name="cards")
    op.drop_table("cards")
    op.drop_table("assignments")
    op.drop_table("session_participants")
    op.drop_table("scenario_pack_items")
    op.drop_table("trainee_ratings")
    op.drop_table("settings")
    op.drop_table("sessions")
    op.drop_table("scenarios")
    op.drop_table("scenario_packs")
    op.drop_index(op.f("ix_auth_sessions_user_id"), table_name="auth_sessions")
    op.drop_index(op.f("ix_auth_sessions_expires_at"), table_name="auth_sessions")
    op.drop_table("auth_sessions")
    op.drop_index(op.f("ix_audit_log_ts"), table_name="audit_log")
    op.drop_table("audit_log")
    op.drop_table("users")
    op.drop_table("routing_rules")
    op.drop_table("workstations")
    op.drop_index(op.f("ix_streets_name_norm"), table_name="streets")
    op.drop_table("streets")
    op.drop_table("services")
    op.drop_table("seed_artifacts")
    op.drop_index("ix_jobs_status_run_after", table_name="jobs")
    op.drop_table("jobs")
    op.drop_table("incident_types")
    op.execute("DROP FUNCTION reject_journal_change()")
