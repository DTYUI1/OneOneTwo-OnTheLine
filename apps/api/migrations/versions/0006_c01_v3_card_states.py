"""Статусы «Прибытие» и «Проведение работ» (дополнение C-01 от 24.09)."""

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None

OLD_STATES = (
    "'added','received','accepted','rejected','responding','refused','completed','redirected'"
)
NEW_STATES = (
    "'added','received','accepted','rejected','responding',"
    "'arrived','working','refused','completed','redirected'"
)


def upgrade() -> None:
    op.drop_constraint("cards_state_check", "cards", type_="check")
    op.create_check_constraint("cards_state_check", "cards", f"state IN ({NEW_STATES})")


def downgrade() -> None:
    # Карточку в новом статусе нельзя молча перевести в старый: это переписало бы историю.
    used = op.get_bind().scalar(
        sa.text("SELECT count(*) FROM cards WHERE state IN ('arrived','working')")
    )
    if used:
        raise RuntimeError(
            "Есть карточки в статусах arrived/working; откат версии — только через backup/restore."
        )
    op.drop_constraint("cards_state_check", "cards", type_="check")
    op.create_check_constraint("cards_state_check", "cards", f"state IN ({OLD_STATES})")
