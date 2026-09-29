"""Снимок методики времени занятия (C-02, I-TIME v3)."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Старые занятия остаются NULL = legacy v1: их попытки не переинтерпретируются.
    op.add_column("sessions", sa.Column("timing_policy", JSONB(), nullable=True))


def downgrade() -> None:
    used = op.get_bind().scalar(
        sa.text("SELECT count(*) FROM sessions WHERE timing_policy IS NOT NULL")
    )
    if used:
        raise RuntimeError(
            "Есть занятия со снимком методики времени; откат — только через backup/restore."
        )
    op.drop_column("sessions", "timing_policy")
