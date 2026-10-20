"""TC-12: ход занятия — пауза занятия и ученика, сообщения ученику (contracts/live-lesson.md).

После слияния gameplay и infra миграция продолжает 0018 (brigade_briefings).
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sessions", sa.Column("paused_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "session_participants",
        sa.Column("paused_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_table(
        "teacher_messages",
        sa.Column("id", UUID(), primary_key=True),
        sa.Column("session_id", UUID(), sa.ForeignKey("sessions.id"), nullable=False),
        sa.Column("user_id", UUID(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("teacher_id", UUID(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("text", sa.String(), nullable=False),
        sa.Column(
            "sent_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("char_length(text) BETWEEN 1 AND 500", name="ck_teacher_messages_text"),
    )
    op.create_index("ix_teacher_messages_user_sent", "teacher_messages", ["user_id", "sent_at"])
    op.create_index(
        "ix_teacher_messages_session_sent", "teacher_messages", ["session_id", "sent_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_teacher_messages_session_sent", table_name="teacher_messages")
    op.drop_index("ix_teacher_messages_user_sent", table_name="teacher_messages")
    op.drop_table("teacher_messages")
    op.drop_column("session_participants", "paused_at")
    op.drop_column("sessions", "paused_at")
