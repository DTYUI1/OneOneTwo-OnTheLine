"""Дата создания новых пакетов; неизвестные исторические даты остаются NULL."""

import sqlalchemy as sa
from alembic import op

revision = "0028"
down_revision = "0027"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "scenario_packs", sa.Column("created_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.alter_column("scenario_packs", "created_at", server_default=sa.func.now())


def downgrade() -> None:
    op.drop_column("scenario_packs", "created_at")
