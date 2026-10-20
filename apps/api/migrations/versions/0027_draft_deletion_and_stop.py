"""Мягкое удаление черновиков и независимый запрос остановки генерации."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0027"
down_revision = "0026"
branch_labels = None
depends_on = None


def upgrade() -> None:
    for table in ("sessions", "scenarios"):
        op.add_column(table, sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
        op.add_column(
            table, sa.Column("deleted_by", UUID(), sa.ForeignKey("users.id"), nullable=True)
        )
    op.create_table(
        "job_cancellations",
        # Без FK: проверка внешнего ключа ждала бы долгую блокировку jobs у воркера.
        sa.Column("job_id", UUID(), primary_key=True),
        sa.Column(
            "requested_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("requested_by", UUID(), sa.ForeignKey("users.id"), nullable=False),
    )
    op.drop_constraint("jobs_status_check", "jobs", type_="check")
    op.create_check_constraint(
        "jobs_status_check",
        "jobs",
        "status IN ('pending', 'running', 'done', 'failed', 'cancelled')",
    )


def downgrade() -> None:
    op.execute(
        "UPDATE jobs SET status = 'failed', error = 'Генерация остановлена.' "
        "WHERE status = 'cancelled'"
    )
    op.drop_constraint("jobs_status_check", "jobs", type_="check")
    op.create_check_constraint(
        "jobs_status_check", "jobs", "status IN ('pending', 'running', 'done', 'failed')"
    )
    op.drop_table("job_cancellations")
    for table in ("scenarios", "sessions"):
        op.drop_column(table, "deleted_by")
        op.drop_column(table, "deleted_at")
