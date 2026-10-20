"""DT-10: срабатывания событий бригады на карточке (живая бригада, вводные преподавателя).

Событие плана (`TrainingPlan.events`) или вводная срабатывает на карточке не больше одного
раза. Журнал append-only: исходы не хранятся — их считает evalcore из журнала карточки,
поэтому ход мира и разбор совпадают (contracts/scenario-events.md, «Принято 08.10»).
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "scenario_event_firings",
        sa.Column("id", UUID(), primary_key=True),
        sa.Column("card_id", UUID(), sa.ForeignKey("cards.id"), nullable=False),
        sa.Column("event_id", UUID(), nullable=False),
        sa.Column("event_version", sa.Integer(), nullable=False),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("injected_by", UUID(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("fired_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("card_id", "event_id", name="uq_scenario_event_firings_card_event"),
        sa.CheckConstraint("source IN ('plan', 'inject')", name="ck_scenario_event_firings_source"),
        sa.CheckConstraint(
            "(source = 'inject') = (injected_by IS NOT NULL)",
            name="ck_scenario_event_firings_injected_by",
        ),
    )


def downgrade() -> None:
    op.drop_table("scenario_event_firings")
