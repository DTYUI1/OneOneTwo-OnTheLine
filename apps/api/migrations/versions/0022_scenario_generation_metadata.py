"""Происхождение и результаты автоматического допуска нового сценария."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0022"
down_revision = "0021"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("scenarios", sa.Column("generation_metadata", JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("scenarios", "generation_metadata")
