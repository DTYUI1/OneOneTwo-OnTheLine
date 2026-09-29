"""Подсказки орфографии в АРМ (28.09): та же проверка, что критерий грамотности при оценке.

Обучаемому — только в карточке своего занятия с включёнными подсказками (spelling_hints):
в контрольном занятии подсказки дали бы ответ на критерий. Запрос ничего не меняет и в
журнал аудита не пишется (core/audit.py, READ_ONLY_OPERATIONS).
"""

from fastapi import HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.spelling import schemas
from app.core.models import Assignment, Card, Participant, Scenario, Session, Street
from app.core.spelling import for_scenario


def utf16(text: str, index: int) -> int:
    """Позиция в строке JavaScript: символы вне BMP (эмодзи) занимают две единицы."""
    return len(text[:index].encode("utf-16-le")) // 2


async def check_spelling(request: Request, body: schemas.SpellingInput) -> schemas.SpellingCheck:
    db: AsyncSession = request.state.db
    user = request.state.user
    card, reference = None, None
    if body.card_id is not None:
        query = (
            select(Scenario.card, Scenario.reference, Session.settings_snapshot)
            .select_from(Card)
            .join(Assignment, Assignment.id == Card.assignment_id)
            .join(Participant, Participant.id == Assignment.participant_id)
            .join(Scenario, Scenario.id == Assignment.scenario_id)
            .join(Session, Session.id == Assignment.session_id)
            .where(Card.id == body.card_id)
        )
        if user.role == "trainee":
            query = query.where(Participant.user_id == user.id)
        else:
            query = query.where(Session.teacher_id == user.id)
        row = (await db.execute(query)).one_or_none()
        if row is None:
            raise HTTPException(404, "Карточка не найдена.")
        card, reference, settings = row
        if user.role == "trainee" and not settings.get("spelling_hints", False):
            raise hints_off()
    elif user.role == "trainee":
        raise hints_off()
    streets = tuple((await db.scalars(select(Street.name))).all())
    issues = for_scenario(streets, card, reference).check(body.text)
    return schemas.SpellingCheck(
        issues=[
            schemas.SpellingSuggestion(
                start=utf16(body.text, issue.start),
                end=utf16(body.text, issue.end),
                word=issue.word,
                suggestions=list(issue.suggestions),
            )
            for issue in issues
        ]
    )


def hints_off() -> HTTPException:
    return HTTPException(
        409,
        {
            "code": "spelling_hints_off",
            "message": "Подсказки орфографии в этом занятии выключены.",
            "details": {},
        },
    )
