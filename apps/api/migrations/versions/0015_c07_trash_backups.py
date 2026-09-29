"""C-07: корзина учётных записей и журнал резервных копий.

Удаление учётки — строка в user_deletions; обезличивает worker только после копии,
начатой позже удаления (ТЗ: не удалять критичные данные без резервного копирования).
Таблица users не меняется: её читают миграционные проверки старых ревизий.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_deletions",
        sa.Column("user_id", UUID(), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_by", UUID(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("reason", sa.String(), nullable=False),
        sa.Column("purged_at", sa.DateTime(timezone=True), nullable=True),
    )
    # Копии пишет контейнер backup (psql): и ночные, и запрошенные кнопкой администратора.
    op.create_table(
        "backups",
        sa.Column("id", UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("requested_by", UUID(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column(
            "requested_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("name", sa.String(), nullable=True),
        sa.Column("error", sa.String(), nullable=True),
        sa.CheckConstraint(
            "status IN ('pending', 'running', 'done', 'failed')", name="ck_backups_status"
        ),
    )
    op.create_index("ix_backups_status_started_at", "backups", ["status", "started_at"])


def downgrade() -> None:
    op.drop_index("ix_backups_status_started_at", table_name="backups")
    op.drop_table("backups")
    op.drop_table("user_deletions")
