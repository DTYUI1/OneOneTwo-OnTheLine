"""Сохранить атомарные пачки и завершение занятия без изменения истории действий."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "card_event_receipts",
        sa.Column("event_id", UUID(), sa.ForeignKey("card_events.id"), primary_key=True),
        sa.Column("receipt", JSONB(), nullable=False),
    )
    op.create_table(
        "assignment_batches",
        sa.Column("id", UUID(), primary_key=True),
        sa.Column("teacher_id", UUID(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("session_id", UUID(), sa.ForeignKey("sessions.id"), nullable=False),
        sa.Column("request_id", UUID(), nullable=False),
        sa.Column("canonical_request", sa.String(), nullable=False),
        sa.Column("receipt", JSONB(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("teacher_id", "session_id", "request_id"),
    )
    op.create_table(
        "session_finishes",
        sa.Column("id", UUID(), primary_key=True),
        sa.Column("session_id", UUID(), sa.ForeignKey("sessions.id"), nullable=False, unique=True),
        sa.Column("teacher_id", UUID(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("request_id", UUID(), nullable=True),
        sa.Column("receipt", JSONB(), nullable=False),
    )
    for name, kind in [
        ("batch_id", UUID()),
        ("scenario_version", sa.Integer()),
        ("delay_from_start_s", sa.Integer()),
        ("delivery_mode", sa.String()),
        ("due_at", sa.DateTime(timezone=True)),
        ("cancelled_at", sa.DateTime(timezone=True)),
    ]:
        op.add_column("assignments", sa.Column(name, kind, nullable=True))
    op.create_foreign_key(
        "fk_assignments_batch", "assignments", "assignment_batches", ["batch_id"], ["id"]
    )
    op.create_check_constraint(
        "ck_assignments_delay", "assignments", "delay_from_start_s BETWEEN 0 AND 86400"
    )
    op.drop_constraint("ck_assignments_status", "assignments", type_="check")
    op.create_check_constraint(
        "ck_assignments_status",
        "assignments",
        "status IN ('pending', 'delivered', 'completed', 'cancelled')",
    )
    op.add_column("cards", sa.Column("interrupted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("calls", sa.Column("end_reason", sa.String(), nullable=True))


def downgrade() -> None:
    # После использования v2 откат теряет receipts/evidence; требуем явный backup/restore.
    connection = op.get_bind()
    used = connection.execute(
        sa.text(
            "SELECT EXISTS (SELECT 1 FROM assignment_batches) "
            "OR EXISTS (SELECT 1 FROM session_finishes) "
            "OR EXISTS (SELECT 1 FROM card_event_receipts)"
        )
    ).scalar()
    if used:
        raise RuntimeError("C-03 уже содержит историю. Для отката используйте backup/restore.")
    op.drop_column("calls", "end_reason")
    op.drop_column("cards", "interrupted_at")
    op.drop_constraint("ck_assignments_status", "assignments", type_="check")
    op.create_check_constraint(
        "ck_assignments_status", "assignments", "status IN ('pending', 'delivered', 'completed')"
    )
    op.drop_constraint("ck_assignments_delay", "assignments", type_="check")
    op.drop_constraint("fk_assignments_batch", "assignments", type_="foreignkey")
    for name in [
        "cancelled_at",
        "due_at",
        "delivery_mode",
        "delay_from_start_s",
        "scenario_version",
        "batch_id",
    ]:
        op.drop_column("assignments", name)
    op.drop_table("session_finishes")
    op.drop_table("assignment_batches")
    op.drop_table("card_event_receipts")
