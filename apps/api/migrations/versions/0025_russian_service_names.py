"""Имена учебных записей — с названием службы, а не её идентификатором.

Сид не переписывает уже созданные бригады и абонентов (`on_conflict_do_nothing`), поэтому на
поднятых стендах в телефоне ДДС оставалось «Учебная бригада 1 службы GKH» и «Учебный
диспетчер MOSLIFT» — латиница в русском интерфейсе. Миграция переименовывает только записи,
собранные сидом по шаблону, и только у служб с нецифровым идентификатором; имена, которые
правил преподаватель, под шаблон не подходят и остаются как есть.
"""

from alembic import op

revision = "0025"
down_revision = "0024"
branch_labels = None
depends_on = None

BRIGADES = """
UPDATE brigades AS b
SET name = replace(b.name, 'службы ' || b.service_id, 'службы ' || s.name)
FROM services AS s
WHERE s.id = b.service_id
  AND s.id !~ '^[0-9]+$'
  AND b.name LIKE 'Учебная бригада % службы ' || b.service_id
"""

DISPATCHERS = """
UPDATE call_targets AS t
SET name = 'Учебный диспетчер ' || s.name
FROM services AS s
WHERE s.id = t.service_id
  AND s.id !~ '^[0-9]+$'
  AND t.name = 'Учебный диспетчер ' || t.service_id
"""


def upgrade() -> None:
    op.execute(BRIGADES)
    op.execute(DISPATCHERS)


def downgrade() -> None:
    """Обратно — тем же шаблоном: имя по названию службы снова становится идентификатором."""
    op.execute(
        """
        UPDATE brigades AS b
        SET name = replace(b.name, 'службы ' || s.name, 'службы ' || b.service_id)
        FROM services AS s
        WHERE s.id = b.service_id
          AND s.id !~ '^[0-9]+$'
          AND b.name LIKE 'Учебная бригада % службы ' || s.name
        """
    )
    op.execute(
        """
        UPDATE call_targets AS t
        SET name = 'Учебный диспетчер ' || t.service_id
        FROM services AS s
        WHERE s.id = t.service_id
          AND s.id !~ '^[0-9]+$'
          AND t.name = 'Учебный диспетчер ' || s.name
        """
    )
