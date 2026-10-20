"""Общий контекст телефона ДДС: служба участника и абоненты снимка занятия."""

from dataclasses import dataclass

from evalcore import defaults
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models import Assignment, Card, Participant, Session


@dataclass(frozen=True)
class CardPhone:
    service_id: str | None
    contacts: tuple[dict[str, str], ...]

    def numbers(self, role: str | None = None) -> set[str]:
        """Номера всей телефонной книги либо только заданной роли."""
        return {item["number"] for item in self.contacts if role is None or item["role"] == role}


async def card_phone(db: AsyncSession, card: Card) -> CardPhone:
    """Один источник справочника для набора номера, заявителя и отдела контроля."""
    row = (
        await db.execute(
            select(Session.settings_snapshot, Participant.dds_service_id)
            .join(Assignment, Assignment.session_id == Session.id)
            .join(Participant, Participant.id == Assignment.participant_id)
            .where(Assignment.id == card.assignment_id)
        )
    ).one_or_none()
    if row is None:
        return CardPhone(None, ())
    return CardPhone(row[1], tuple(defaults.phone_contacts(row[0], row[1])))
