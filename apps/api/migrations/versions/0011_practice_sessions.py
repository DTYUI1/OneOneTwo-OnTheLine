"""Личная тренировка обучаемого: вид занятия lesson/practice."""

import sqlalchemy as sa
from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Все прежние занятия созданы преподавателем — они lesson.
    op.add_column(
        "sessions",
        sa.Column("kind", sa.String(), nullable=False, server_default="lesson"),
    )
    op.create_check_constraint("ck_sessions_kind", "sessions", "kind IN ('lesson', 'practice')")


def downgrade() -> None:
    op.drop_constraint("ck_sessions_kind", "sessions", type_="check")
    op.drop_column("sessions", "kind")
