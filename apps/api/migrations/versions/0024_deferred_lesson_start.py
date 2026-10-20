"""Серверное ожидание готовности общей генерации перед стартом занятия."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0024"
down_revision = "0023"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sessions", sa.Column("start_request", JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("sessions", "start_request")
