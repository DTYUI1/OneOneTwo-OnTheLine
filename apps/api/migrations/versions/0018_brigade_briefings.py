"""GP-05: вводные бригадам — бригада выезжает только после разговора с диспетчером.

Вводная (событие карточки `brigade_briefing`) оценивается один раз при приёме: что бригада
поняла — адрес (`ok`, `wrong`, `missing`), адрес, по которому поедет, и прозвучал ли повод
(`evalcore.briefing`). Мир (выезд, прибытие не туда) и разбор читают одну запись, поэтому не
расходятся. Журнал append-only.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "brigade_briefings",
        sa.Column("id", UUID(), primary_key=True),
        sa.Column("card_id", UUID(), sa.ForeignKey("cards.id"), nullable=False),
        sa.Column("call_id", UUID(), sa.ForeignKey("calls.id"), nullable=False),
        sa.Column("brigade_id", UUID(), sa.ForeignKey("brigades.id"), nullable=False),
        sa.Column("briefed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("mode", sa.String(), nullable=False),
        sa.Column("text", sa.String(), nullable=False),
        sa.Column("address", sa.String(), nullable=False),
        sa.Column("heard_address", sa.String(), nullable=True),
        sa.Column("incident", sa.Boolean(), nullable=False),
        sa.Column("complete", sa.Boolean(), nullable=False),
        sa.CheckConstraint("mode IN ('voice', 'parts')", name="ck_brigade_briefings_mode"),
        sa.CheckConstraint(
            "address IN ('ok', 'wrong', 'missing')", name="ck_brigade_briefings_address"
        ),
    )
    op.create_index("ix_brigade_briefings_card", "brigade_briefings", ["card_id", "briefed_at"])
    # До GP-05 отправкой считался первый отвеченный звонок без отказа. Снимок делаем
    # именно на границе изменения, а не по отсутствию вводной у новых карточек.
    op.create_table(
        "legacy_brigade_dispatches",
        sa.Column("card_id", UUID(), sa.ForeignKey("cards.id"), primary_key=True),
        sa.Column("brigade_id", UUID(), sa.ForeignKey("brigades.id"), primary_key=True),
        sa.Column("dispatched_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.execute(
        sa.text("""
        INSERT INTO legacy_brigade_dispatches (card_id, brigade_id, dispatched_at)
        SELECT card_id, brigade_id, min(answered_at)
        FROM calls
        WHERE brigade_id IS NOT NULL AND answered_at IS NOT NULL AND refusal IS NULL
        GROUP BY card_id, brigade_id
    """)
    )


def downgrade() -> None:
    op.execute(sa.text("DROP TABLE IF EXISTS legacy_brigade_dispatches"))
    op.drop_index("ix_brigade_briefings_card", table_name="brigade_briefings")
    op.drop_table("brigade_briefings")
