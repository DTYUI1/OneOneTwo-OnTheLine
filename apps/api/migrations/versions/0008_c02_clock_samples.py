"""Образцы часов v2 и ссылка события карточки на них (C-02, I-TIME)."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "clock_samples",
        sa.Column("id", UUID(), primary_key=True),
        sa.Column("actor_id", UUID(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("client_sent_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("server_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("client_received_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("offset_ms", sa.Float(), nullable=True),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_clock_samples_actor_id", "clock_samples", ["actor_id"])
    op.add_column(
        "card_events",
        sa.Column("clock_sample_id", UUID(), sa.ForeignKey("clock_samples.id"), nullable=True),
    )


def downgrade() -> None:
    used = op.get_bind().scalar(
        sa.text("SELECT count(*) FROM card_events WHERE clock_sample_id IS NOT NULL")
    )
    if used:
        raise RuntimeError(
            "События ссылаются на образцы часов; откат — только через backup/restore."
        )
    op.drop_column("card_events", "clock_sample_id")
    op.drop_index("ix_clock_samples_actor_id", table_name="clock_samples")
    op.drop_table("clock_samples")
