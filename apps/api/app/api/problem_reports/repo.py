from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models import ProblemReport, User

# Администратор читает свежие сообщения; старые остаются в базе и в выгрузке БД.
LIST_LIMIT = 200


async def latest(db: AsyncSession) -> list[tuple[ProblemReport, User]]:
    rows = await db.execute(
        select(ProblemReport, User)
        .join(User, User.id == ProblemReport.author_id)
        .order_by(ProblemReport.created_at.desc(), ProblemReport.id)
        .limit(LIST_LIMIT)
    )
    return [(report, author) for report, author in rows.tuples()]
