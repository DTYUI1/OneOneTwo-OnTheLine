"""Сообщения об ошибках: кнопка в шапке для всех ролей, читает администратор (28.09)."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "problem_reports",
        sa.Column("id", UUID(), primary_key=True),
        sa.Column("author_id", UUID(), sa.ForeignKey("users.id"), nullable=False),
        # Снимок роли и экрана на момент сообщения.
        sa.Column("author_role", sa.String(), nullable=False),
        sa.Column("category", sa.String(), nullable=False),
        sa.Column("text", sa.String(), nullable=False),
        sa.Column("page", sa.String(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "category IN ('bug', 'evaluation', 'unclear', 'other')",
            name="ck_problem_reports_category",
        ),
        sa.CheckConstraint("char_length(text) BETWEEN 1 AND 2000", name="ck_problem_reports_text"),
    )
    op.create_index("ix_problem_reports_created_at", "problem_reports", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_problem_reports_created_at", table_name="problem_reports")
    op.drop_table("problem_reports")
