"""TC-13: отзыв ученику по итогам занятия (contracts/lesson-review.md)."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "lesson_feedback",
        sa.Column("id", UUID(), primary_key=True),
        sa.Column("session_id", UUID(), sa.ForeignKey("sessions.id"), nullable=False),
        sa.Column("user_id", UUID(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("draft", sa.String(), nullable=False),
        sa.Column("text", sa.String(), nullable=True),
        sa.Column("released_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("session_id", "user_id"),
    )


def downgrade() -> None:
    op.drop_table("lesson_feedback")
