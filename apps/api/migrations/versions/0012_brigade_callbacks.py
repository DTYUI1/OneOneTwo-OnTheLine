"""Бригада звонит сама: входящие звонки и расписание докладов для ожидания."""

import sqlalchemy as sa
from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Все прежние звонки набирал диспетчер.
    op.add_column(
        "calls",
        sa.Column("direction", sa.String(), nullable=False, server_default="outbound"),
    )
    op.create_check_constraint(
        "ck_calls_direction", "calls", "direction IN ('outbound', 'inbound')"
    )
    # Ожидание бригады: с отправки (или нужного статуса) до готовности доклада.
    # У прежних выдач пусто — разбор считает ожидание по-старому, от ответа до выдачи.
    op.add_column(
        "message_deliveries",
        sa.Column("waiting_started_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "message_deliveries", sa.Column("ready_at", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("message_deliveries", "ready_at")
    op.drop_column("message_deliveries", "waiting_started_at")
    op.drop_constraint("ck_calls_direction", "calls", type_="check")
    op.drop_column("calls", "direction")
