"""Защитить инварианты назначений, карточек и звонков T-008."""

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_unique_constraint(
        "uq_assignments_participant_order", "assignments", ["participant_id", "order"]
    )
    op.create_check_constraint("ck_assignments_order", "assignments", '"order" >= 1')
    op.create_check_constraint(
        "ck_assignments_status",
        "assignments",
        "status IN ('pending', 'delivered', 'completed')",
    )
    op.create_check_constraint("ck_cards_number", "cards", "number ~ '^[0-9]{8}$'")
    op.create_check_constraint("ck_calls_dialed_ext", "calls", "dialed_ext ~ '^[0-9]{3}$'")


def downgrade() -> None:
    op.drop_constraint("ck_calls_dialed_ext", "calls", type_="check")
    op.drop_constraint("ck_cards_number", "cards", type_="check")
    op.drop_constraint("ck_assignments_status", "assignments", type_="check")
    op.drop_constraint("ck_assignments_order", "assignments", type_="check")
    op.drop_constraint("uq_assignments_participant_order", "assignments", type_="unique")
