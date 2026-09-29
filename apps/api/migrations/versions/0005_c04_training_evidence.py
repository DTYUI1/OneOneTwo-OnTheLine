"""Бригады, адресаты и независимый журнал выдачи/предъявления сведений."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "brigades",
        sa.Column("id", UUID(), primary_key=True),
        sa.Column("service_id", sa.String(), sa.ForeignKey("services.id"), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
    )
    op.create_table(
        "call_targets",
        sa.Column("id", UUID(), primary_key=True),
        sa.Column("service_id", sa.String(), sa.ForeignKey("services.id"), nullable=False),
        sa.Column("brigade_id", UUID(), sa.ForeignKey("brigades.id")),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("phone_ext", sa.String(), nullable=False, unique=True),
        sa.Column("voice_profile", sa.String(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.CheckConstraint("phone_ext ~ '^[0-9]{3}$'"),
    )
    op.add_column("calls", sa.Column("target_id", UUID(), sa.ForeignKey("call_targets.id")))
    op.add_column("calls", sa.Column("brigade_id", UUID(), sa.ForeignKey("brigades.id")))
    op.create_table(
        "scenario_training_plans",
        sa.Column("scenario_id", UUID(), sa.ForeignKey("scenarios.id"), primary_key=True),
        sa.Column("scenario_version", sa.Integer(), primary_key=True),
        sa.Column("author_id", UUID(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("plan", JSONB(), nullable=False),
    )
    op.create_table(
        "message_audio_assets",
        sa.Column("asset_id", UUID(), primary_key=True),
        sa.Column("version", sa.Integer(), primary_key=True),
        sa.Column("relative_path", sa.String(), nullable=False),
        sa.Column("sha256", sa.String(), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=False),
        sa.Column("media_type", sa.String(), nullable=False),
    )
    op.create_table(
        "card_training_states",
        sa.Column("card_id", UUID(), sa.ForeignKey("cards.id"), primary_key=True),
        sa.Column("revision", sa.Integer(), nullable=False),
    )
    op.create_table(
        "card_brigades",
        sa.Column("card_id", UUID(), sa.ForeignKey("cards.id"), primary_key=True),
        sa.Column("brigade_id", UUID(), sa.ForeignKey("brigades.id"), primary_key=True),
    )
    op.create_table(
        "message_deliveries",
        sa.Column("id", UUID(), primary_key=True),
        sa.Column("card_id", UUID(), sa.ForeignKey("cards.id"), nullable=False),
        sa.Column("call_id", UUID(), sa.ForeignKey("calls.id"), nullable=False),
        sa.Column(
            "participant_id", UUID(), sa.ForeignKey("session_participants.id"), nullable=False
        ),
        sa.Column("brigade_id", UUID(), sa.ForeignKey("brigades.id"), nullable=False),
        sa.Column("target_id", UUID(), sa.ForeignKey("call_targets.id"), nullable=False),
        sa.Column("message_id", UUID(), nullable=False),
        sa.Column("message_version", sa.Integer(), nullable=False),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("message", JSONB(), nullable=False),
        sa.UniqueConstraint("card_id", "message_id", "message_version"),
    )
    op.create_table(
        "message_presentations",
        sa.Column("id", UUID(), primary_key=True),
        sa.Column("delivery_id", UUID(), sa.ForeignKey("message_deliveries.id"), nullable=False),
        sa.Column("event_id", UUID(), sa.ForeignKey("card_events.id"), nullable=False, unique=True),
        sa.Column("actor_id", UUID(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("playback_id", UUID(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("recorded_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload", JSONB(), nullable=False),
        sa.UniqueConstraint("actor_id", "playback_id"),
        sa.CheckConstraint("kind IN ('message_presented', 'message_failed')"),
    )
    for table in [
        "scenario_training_plans",
        "message_audio_assets",
        "message_deliveries",
        "message_presentations",
    ]:
        op.execute(
            f"CREATE TRIGGER immutable_journal BEFORE UPDATE OR DELETE ON {table} "
            "FOR EACH ROW EXECUTE FUNCTION reject_journal_change()"
        )
        op.execute(
            f"CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON {table} "
            "FOR EACH STATEMENT EXECUTE FUNCTION reject_journal_change()"
        )


def downgrade() -> None:
    if (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT EXISTS (SELECT 1 FROM message_deliveries) "
                "OR EXISTS (SELECT 1 FROM scenario_training_plans)"
                " OR EXISTS (SELECT 1 FROM message_audio_assets)"
                " OR EXISTS (SELECT 1 FROM card_brigades)"
                " OR EXISTS (SELECT 1 FROM calls WHERE target_id IS NOT NULL)"
            )
        )
        .scalar()
    ):
        raise RuntimeError("C-04 содержит учебную историю. Для отката используйте backup/restore.")
    op.drop_table("message_presentations")
    op.drop_table("message_deliveries")
    op.drop_table("card_brigades")
    op.drop_table("card_training_states")
    op.drop_table("message_audio_assets")
    op.drop_table("scenario_training_plans")
    op.drop_column("calls", "brigade_id")
    op.drop_column("calls", "target_id")
    op.drop_table("call_targets")
    op.drop_table("brigades")
