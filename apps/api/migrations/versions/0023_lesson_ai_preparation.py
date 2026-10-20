"""Режим занятия с автоматической подготовкой индивидуальных заданий."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0023"
down_revision = "0022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sessions", sa.Column("ai_preparation", JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("sessions", "ai_preparation")
