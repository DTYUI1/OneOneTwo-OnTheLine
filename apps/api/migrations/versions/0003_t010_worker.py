"""Добавить аренду jobs, идемпотентность и гарантии планировщика T-010."""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("jobs", sa.Column("locked_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("jobs", sa.Column("idempotency_key", sa.String(), nullable=True))
    op.create_unique_constraint("uq_jobs_idempotency_key", "jobs", ["idempotency_key"])
    op.drop_index("ix_cards_assignment_id", table_name="cards")
    op.create_index("ix_cards_assignment_id", "cards", ["assignment_id"], unique=True)
    op.create_unique_constraint("uq_predictions_card_id", "predictions", ["card_id"])
    op.create_table(
        "worker_heartbeats",
        sa.Column("worker_id", sa.String(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("worker_id"),
    )


def downgrade() -> None:
    op.drop_table("worker_heartbeats")
    op.drop_constraint("uq_predictions_card_id", "predictions", type_="unique")
    op.drop_index("ix_cards_assignment_id", table_name="cards")
    op.create_index("ix_cards_assignment_id", "cards", ["assignment_id"], unique=False)
    op.drop_constraint("uq_jobs_idempotency_key", "jobs", type_="unique")
    op.drop_column("jobs", "idempotency_key")
    op.drop_column("jobs", "locked_at")
