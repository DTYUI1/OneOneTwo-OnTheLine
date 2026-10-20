"""Городские номера служб: в справочнике телефона ДДС рядом с коротким номером.

Номера учебные (+7 (495) 000-…); набранный городской соединяет с той же службой. Seed не
перезаписывает существующие службы, поэтому номера стенда проставляет миграция — те же,
что в data/phonebook.json.
"""

import sqlalchemy as sa
from alembic import op

# В общей ветке 0019 и 0020 уже заняты занятиями infra и применены на стендах.
revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None

PHONES = {
    "101": "+74950001701",
    "102": "+74950002602",
    "103": "+74950003803",
    "104": "+74950004904",
    "GKH": "+74950005205",
    "MOSLIFT": "+74950006306",
    "112": "+74950007112",
}


def upgrade() -> None:
    op.add_column("services", sa.Column("phone", sa.String(), nullable=True))
    op.create_unique_constraint("services_phone_key", "services", ["phone"])
    services = sa.table("services", sa.column("id", sa.String()), sa.column("phone", sa.String()))
    for service_id, phone in PHONES.items():
        op.execute(services.update().where(services.c.id == service_id).values(phone=phone))


def downgrade() -> None:
    op.drop_constraint("services_phone_key", "services", type_="unique")
    op.drop_column("services", "phone")
