"""Квитанции идемпотентных операций C-05 (утверждение пакета)."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "operation_receipts",
        sa.Column("actor_id", UUID(), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("operation", sa.String(), primary_key=True),
        sa.Column("request_id", UUID(), primary_key=True),
        sa.Column("body", JSONB(), nullable=False),
        sa.Column("response", JSONB(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("operation_receipts")
