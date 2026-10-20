"""DT-09: результаты разминки — короткие упражнения на один навык (обучаемый, 11.10).

Номер 0017 после 0016 (DT-10, события бригады): DT-09 влит в dev вторым, поэтому
down_revision — "0016", а SCHEMA_REVISION в app/core/models.py — "0017".
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "warmup_results",
        sa.Column("id", UUID(), primary_key=True),
        sa.Column("trainee_id", UUID(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("correct", sa.Integer(), nullable=False),
        sa.Column("total", sa.Integer(), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=False),
        sa.Column("mistakes", JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint("kind IN ('address', 'routing')", name="ck_warmup_results_kind"),
        sa.CheckConstraint(
            "total BETWEEN 1 AND 100 AND correct BETWEEN 0 AND total",
            name="ck_warmup_results_score",
        ),
        sa.CheckConstraint("duration_ms BETWEEN 0 AND 3600000", name="ck_warmup_results_duration"),
    )
    op.create_index(
        "ix_warmup_results_trainee_created", "warmup_results", ["trainee_id", "created_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_warmup_results_trainee_created", table_name="warmup_results")
    op.drop_table("warmup_results")
