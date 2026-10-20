"""Итоги занятия: отзыв ученику, тепловая карта, выдача отчёта — contracts/lesson-review.md (TC-13).

Как и ход занятия, операции вне openapi.json (образец — api/live/router.py).
"""

from datetime import UTC, datetime
from statistics import fmean
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select

from app.api.evaluations import repo as evaluation_repo
from app.api.evaluations import service as evaluations
from app.api.foundation.router import require_roles
from app.core.models import LessonFeedback, Session

router = APIRouter(prefix="/api", include_in_schema=False)
teacher = [Depends(require_roles("teacher"))]
trainee = [Depends(require_roles("trainee"))]

TEXT_MAX = 2000
FAIL_BELOW = 0.5
ADVICE_SHARE = 0.3

LABELS = {
    "reaction_time": "время реакции",
    "handling_time": "время отработки",
    "status_flow": "последовательность статусов",
    "routing": "маршрутизация по службам",
    "required_fields": "заполнение обязательных полей",
    "address": "адрес",
    "call": "доклад по телефону",
    "spelling": "грамотность комментария",
    "comment_keywords": "ключевые сведения в комментарии",
    "brigade_work": "работа с бригадой",
    "comment_completeness": "полнота комментария",
    "comment_clarity": "понятность комментария",
}


def label(key: str) -> str:
    return LABELS.get(key, key)


class FeedbackInput(BaseModel):
    text: str


class TraineeReview(BaseModel):
    user_id: UUID
    full_name: str
    ai_total: float | None
    final_total: float | None
    draft: str
    text: str | None
    released_at: datetime | None


class HeatRow(BaseModel):
    user_id: UUID
    full_name: str
    cells: dict[str, float | None]


class Heatmap(BaseModel):
    criteria: list[str]
    rows: list[HeatRow]
    advice: list[str]


class Review(BaseModel):
    trainees: list[TraineeReview]
    heatmap: Heatmap


class Released(BaseModel):
    released: int


class OwnFeedback(BaseModel):
    session_id: UUID
    text: str
    released_at: datetime


def build_draft(name: str, total: float | None, scores: dict[str, float]) -> str:
    if total is None or not scores:
        return f"{name}, по этому занятию нет оценённых работ."
    ordered = sorted(scores, key=lambda key: (scores[key], key))
    weak = [key for key in ordered if scores[key] < 1][:2]
    parts = [f"{name}, итог занятия — {round(total * 100)} %."]
    best = ordered[-1]
    if scores[best] >= FAIL_BELOW and best not in weak:
        parts.append(f"Лучше всего получилось: {label(best)}.")
    if weak:
        parts.append("Что подтянуть: " + ", ".join(label(key) for key in weak) + ".")
    else:
        parts.append("Замечаний по критериям нет.")
    return " ".join(parts)


def group_advice(rows: list[HeatRow], criteria: list[str]) -> list[str]:
    advice = []
    for key in criteria:
        scored = [row.cells[key] for row in rows if row.cells.get(key) is not None]
        failed = [value for value in scored if value is not None and value < FAIL_BELOW]
        if scored and len(failed) / len(scored) >= ADVICE_SHARE:
            share = round(len(failed) / len(scored) * 100)
            advice.append(
                f"Критерий «{label(key)}» не получился у {len(failed)} из {len(scored)} "
                f"({share} %): разберите его со всей группой."
            )
    return advice


async def _lesson(request: Request, session_id: UUID) -> Session:
    row = await evaluation_repo.report_session(
        request.state.db, session_id, request.state.user.id, "teacher"
    )
    if row is None:
        raise HTTPException(404, "Занятие не найдено.")
    if row.status == "draft":
        raise HTTPException(409, "Занятие ещё не начиналось.")
    return row


async def _facts(request: Request, session_id: UUID) -> list[dict[str, Any]]:
    """Оценки каждого участника: до и после правок преподавателя, по критериям."""
    db = request.state.db
    participants = await evaluation_repo.report_participants(db, session_id)
    cards = await evaluation_repo.report_cards(db, session_id)
    latest: dict[UUID, Any] = {}
    for row in await evaluation_repo.report_evaluations(db, session_id):
        latest.setdefault(row["Evaluation"].card_id, row)
    overrides = await evaluation_repo.latest_overrides(
        db, [row["Evaluation"].id for row in latest.values()]
    )
    owner_of = {row["Card"].id: row["participant_id"] for row in cards}
    facts = []
    for item in participants:
        participant = item["Participant"]
        ai: list[float] = []
        final: list[float] = []
        by_key: dict[str, list[float]] = {}
        for card_id, owner in owner_of.items():
            found = latest.get(card_id)
            if owner != participant.id or found is None:
                continue
            view = evaluations.serialize(found, overrides.get(found["Evaluation"].id))
            ai.append(float(found["Evaluation"].total))
            final.append(view.total)
            for criterion in view.criteria:
                if criterion.weight == 0:
                    continue
                by_key.setdefault(criterion.key, []).append(criterion.score)
        facts.append(
            {
                "user_id": participant.user_id,
                "full_name": item["full_name"],
                "ai_total": fmean(ai) if ai else None,
                "final_total": fmean(final) if final else None,
                "scores": {key: fmean(values) for key, values in by_key.items()},
            }
        )
    return facts


async def _notes(request: Request, session_id: UUID) -> dict[UUID, LessonFeedback]:
    rows = await request.state.db.scalars(
        select(LessonFeedback).where(LessonFeedback.session_id == session_id)
    )
    return {row.user_id: row for row in rows}


def _view(fact: dict[str, Any], note: LessonFeedback) -> TraineeReview:
    return TraineeReview(
        user_id=fact["user_id"],
        full_name=fact["full_name"],
        ai_total=fact["ai_total"],
        final_total=fact["final_total"],
        draft=note.draft,
        text=note.text,
        released_at=note.released_at,
    )


@router.get("/sessions/{session_id}/review", operation_id="review_get", dependencies=teacher)
async def review(session_id: UUID, request: Request) -> Review:
    await _lesson(request, session_id)
    facts = await _facts(request, session_id)
    notes = await _notes(request, session_id)
    for fact in facts:
        if fact["user_id"] not in notes:
            note = LessonFeedback(
                session_id=session_id,
                user_id=fact["user_id"],
                draft=build_draft(fact["full_name"], fact["final_total"], fact["scores"]),
            )
            request.state.db.add(note)
            notes[fact["user_id"]] = note
        elif notes[fact["user_id"]].text is None and notes[fact["user_id"]].released_at is None:
            # Пока отзыв не правили, черновик догоняет новые оценки.
            notes[fact["user_id"]].draft = build_draft(
                fact["full_name"], fact["final_total"], fact["scores"]
            )
    criteria = sorted({key for fact in facts for key in fact["scores"]})
    rows = [
        HeatRow(
            user_id=fact["user_id"],
            full_name=fact["full_name"],
            cells={key: fact["scores"].get(key) for key in criteria},
        )
        for fact in facts
    ]
    return Review(
        trainees=[_view(fact, notes[fact["user_id"]]) for fact in facts],
        heatmap=Heatmap(criteria=criteria, rows=rows, advice=group_advice(rows, criteria)),
    )


@router.put(
    "/sessions/{session_id}/feedback/{user_id}", operation_id="review_edit", dependencies=teacher
)
async def edit_feedback(
    session_id: UUID, user_id: UUID, body: FeedbackInput, request: Request
) -> TraineeReview:
    await _lesson(request, session_id)
    text = body.text.strip()
    if not 1 <= len(text) <= TEXT_MAX:
        raise HTTPException(422, f"Отзыв — от 1 до {TEXT_MAX} символов.")
    facts = await _facts(request, session_id)
    fact = next((item for item in facts if item["user_id"] == user_id), None)
    if fact is None:
        raise HTTPException(422, "Этого ученика нет в занятии.")
    note = (await _notes(request, session_id)).get(user_id)
    if note is None:
        note = LessonFeedback(
            session_id=session_id,
            user_id=user_id,
            draft=build_draft(fact["full_name"], fact["final_total"], fact["scores"]),
        )
        request.state.db.add(note)
    if note.released_at is not None:
        raise HTTPException(409, "Отчёт уже выдан, отзыв не меняется.")
    note.text = text
    await request.state.db.flush()
    request.state.entity = "lesson_feedback"
    request.state.entity_id = str(note.id)
    return _view(fact, note)


@router.post(
    "/sessions/{session_id}/feedback/release", operation_id="review_release", dependencies=teacher
)
async def release(session_id: UUID, request: Request) -> Released:
    await _lesson(request, session_id)
    facts = await _facts(request, session_id)
    notes = await _notes(request, session_id)
    now = datetime.now(UTC)
    released = 0
    for fact in facts:
        note = notes.get(fact["user_id"])
        if note is None:
            note = LessonFeedback(
                session_id=session_id,
                user_id=fact["user_id"],
                draft=build_draft(fact["full_name"], fact["final_total"], fact["scores"]),
            )
            request.state.db.add(note)
        if note.released_at is None:
            note.text = note.text or note.draft
            note.released_at = now
            released += 1
    await request.state.db.flush()
    request.state.entity = "lesson_feedback"
    request.state.entity_id = str(session_id)
    return Released(released=released)


@router.get("/feedback", operation_id="review_own", dependencies=trainee)
async def own_feedback(request: Request) -> list[OwnFeedback]:
    rows = await request.state.db.scalars(
        select(LessonFeedback)
        .where(
            LessonFeedback.user_id == request.state.user.id,
            LessonFeedback.released_at.is_not(None),
        )
        .order_by(LessonFeedback.released_at.desc())
    )
    return [
        OwnFeedback(
            session_id=row.session_id, text=row.text or row.draft, released_at=row.released_at
        )
        for row in rows
        if row.released_at is not None
    ]
