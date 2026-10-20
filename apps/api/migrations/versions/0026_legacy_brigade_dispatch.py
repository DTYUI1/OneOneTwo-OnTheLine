"""Совместимость схемы для БД, уже прошедших исходную миграцию вводных.

У таких БД граница GP-05 не сохранена: отсутствие вводной не доказывает старую отправку.
Не превращаем современные неотправленные бригады в отправленные. Для истории нужна
подтверждённая граница обновления или список карточек; свежий upgrade через 0018 уже
сохраняет точный снимок прежней отправки.
"""

from datetime import datetime

import sqlalchemy as sa
from alembic import context, op

revision = "0026"
down_revision = "0025"
branch_labels = None
depends_on = None


def upgrade() -> None:
    cutoff_text = context.get_x_argument(as_dictionary=True).get("brigade_briefing_cutover")
    cutoff = datetime.fromisoformat(cutoff_text) if cutoff_text else None
    if cutoff is not None and cutoff.utcoffset() is None:
        raise ValueError("brigade_briefing_cutover должен содержать часовой пояс.")
    op.execute(
        sa.text("""
        CREATE TABLE IF NOT EXISTS legacy_brigade_dispatches (
            card_id uuid NOT NULL REFERENCES cards(id),
            brigade_id uuid NOT NULL REFERENCES brigades(id),
            dispatched_at timestamptz NOT NULL,
            PRIMARY KEY (card_id, brigade_id)
        )
    """)
    )

    if cutoff is not None:
        # Только известная администратору граница GP-05; отсутствие строк вводной
        # само по себе не даёт права считать новый разговор отправкой.
        op.get_bind().execute(
            sa.text("""
                INSERT INTO legacy_brigade_dispatches (card_id, brigade_id, dispatched_at)
                SELECT calls.card_id, calls.brigade_id, min(calls.answered_at)
                FROM calls JOIN cards ON cards.id = calls.card_id
                WHERE calls.brigade_id IS NOT NULL AND calls.refusal IS NULL
                    AND calls.answered_at <= :cutoff AND cards.appeared_at <= :cutoff
                GROUP BY calls.card_id, calls.brigade_id
                ON CONFLICT (card_id, brigade_id) DO NOTHING
            """),
            {"cutoff": cutoff},
        )


def downgrade() -> None:
    # Снимок принадлежит 0018: промежуточный откат не должен уничтожить историю.
    pass
