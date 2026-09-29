"""Звонок бригаде, которая не направлена на происшествие: она отвечает отказом.

Диспетчер ДДС связан со всеми своими бригадами, номер не «разблокируется» выбором.
Отказ фиксируется при наборе: по такому звонку бригада не докладывает, даже если её
направят во время разговора, — нужен новый звонок (решение капитана 28.09).
"""

import sqlalchemy as sa
from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # У прежних звонков пусто: звонить ненаправленной бригаде было нельзя.
    op.add_column("calls", sa.Column("refusal", sa.String(), nullable=True))
    op.create_check_constraint(
        "ck_calls_refusal", "calls", "refusal IS NULL OR refusal IN ('busy', 'not_assigned')"
    )


def downgrade() -> None:
    op.drop_constraint("ck_calls_refusal", "calls", type_="check")
    op.drop_column("calls", "refusal")
