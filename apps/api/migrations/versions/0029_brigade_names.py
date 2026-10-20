"""Бригада называется своим прямым номером; ручные имена сохраняются."""

from uuid import NAMESPACE_URL, uuid5

import sqlalchemy as sa
from alembic import op

revision = "0029"
down_revision = "0028"
branch_labels = None
depends_on = None

services = sa.table(
    "services",
    sa.column("id", sa.String()),
    sa.column("name", sa.String()),
)
brigades = sa.table(
    "brigades",
    sa.column("id", sa.Uuid()),
    sa.column("service_id", sa.String()),
    sa.column("name", sa.String()),
)
targets = sa.table(
    "call_targets",
    sa.column("id", sa.Uuid()),
    sa.column("brigade_id", sa.Uuid()),
    sa.column("name", sa.String()),
    sa.column("phone_ext", sa.String()),
)


def _tag(service_id: str, service_name: str | None) -> str:
    # Как в сиде и в 0025: цифровая ДДС — номером, остальные — названием службы.
    return service_id if service_id.isdigit() or not service_name else service_name


def _rename(*, reverse: bool) -> None:
    connection = op.get_bind()
    rows = connection.execute(
        sa.select(
            brigades.c.id,
            brigades.c.service_id,
            services.c.name.label("service_name"),
            targets.c.id.label("target_id"),
            targets.c.phone_ext,
        ).select_from(
            brigades.join(targets, targets.c.brigade_id == brigades.c.id).outerjoin(
                services, services.c.id == brigades.c.service_id
            )
        )
    ).all()
    for row in rows:
        # UUID и четыре порядковых номера зафиксированы сидом на ревизии 0024.
        # Не импортируем изменяемый seed; номер берём у абонента этой же бригады.
        ordinal = next(
            (
                value
                for value in range(4)
                if row.id == uuid5(NAMESPACE_URL, f"arm112:c04:{row.service_id}:brigade:{value}")
            ),
            None,
        )
        if ordinal is None:
            continue
        tag = _tag(row.service_id, row.service_name)
        # Имя сида до 0025 — с идентификатором службы, после — с тегом (у ЖКХ — название).
        seeded = {
            f"Учебная бригада {ordinal + 1} службы {value}" for value in (row.service_id, tag)
        }
        names = (
            (
                brigades,
                row.id,
                seeded,
                f"Учебная бригада {ordinal + 1} службы {tag}",
                f"Бригада {row.phone_ext}",
            ),
            (
                targets,
                row.target_id,
                {f"Учебный старший бригады {ordinal + 1}"},
                f"Учебный старший бригады {ordinal + 1}",
                f"Старший бригады {row.phone_ext}",
            ),
        )
        for table, record_id, olds, old, new in names:
            sources, destination = ({new}, old) if reverse else (olds, new)
            connection.execute(
                table.update()
                .where(table.c.id == record_id, table.c.name.in_(sorted(sources)))
                .values(name=destination)
            )


def upgrade() -> None:
    _rename(reverse=False)


def downgrade() -> None:
    _rename(reverse=True)
