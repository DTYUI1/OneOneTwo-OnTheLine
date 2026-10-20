"""Проверка памяти посреди финальной смены (HQ-033; contracts/C01_INTERFACES.md).

Прототип A (02.10, «Стоп-кадр»): посреди смены с несколькими карточками три вопроса об
обстановке — сколько бригад свободно, какие на месте, по какой карточке не отмечен доклад.
Решение 18.10: без паузы — часов смены, которые можно остановить, в тренажёре нет, мир идёт
дальше. Поэтому верные ответы сервер фиксирует в момент показа: запись `memory_check` в
журнале первой карточки смены; ответы сверяются с ней, а не с тем, что стало потом.
Обучаемому журнал отдаёт эту запись без верных ответов, пока он не ответил (`sealed`).
В оценку проверка не входит: разбор и лента преподавателя показывают «N из 3».
"""

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid5

from fastapi import HTTPException, Request
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from app.api.c01 import C01Input
from app.api.cards.schemas import StoredEvent
from app.api.notifications import notify
from app.api.sessions import repo
from app.api.training.brigades import brigade_roster
from app.api.training.status_evidence import heard_reports
from app.core.models import Assignment, Brigade, Card, CardBrigade, CardEvent, Scenario

CHECK = "memory_check"
ANSWER = "memory_check_answer"
NONE_ON_SCENE = "Ни одна"
ALL_MARKED = "По всем отмечено"
# Ход статусов службы: доклад этапа дальше статуса карточки — услышан, но не отмечен.
_ORDER = {
    "added": 0,
    "received": 0,
    "accepted": 1,
    "rejected": 1,
    "responding": 2,
    "arrived": 3,
    "working": 4,
    "completed": 5,
    "refused": 5,
}
_ON_SCENE = frozenset({"arrived", "working"})
_LEFT = frozenset({"completed", "refused"})
_STAGE_NAMES = {
    "responding": "Начало реагирования",
    "arrived": "Прибытие",
    "working": "Проведение работ",
    "completed": "Работы завершены",
    "refused": "Отказ от выполнения работ",
}


# Что из вопроса видит обучаемый до ответа: верные варианты и пояснение — только после.
SHOWN = ("key", "text", "options", "multiple")


def sealed(events: list[StoredEvent]) -> list[StoredEvent]:
    """Журнал карточки для обучаемого: в записи `memory_check` до его ответа нет верных
    вариантов и пояснений — сервер хранит их там же (решение 18.10: без паузы ответы
    фиксируются на момент показа), но отдаёт только с итогом. Запись не меняется."""
    if any(event.type == ANSWER for event in events):
        return events
    return [
        event.model_copy(
            update={
                "payload": {
                    **event.payload,
                    "questions": [
                        {key: question[key] for key in SHOWN}
                        for question in event.payload.get("questions", [])
                    ],
                }
            }
        )
        if event.type == CHECK
        else event
        for event in events
    ]


class MemoryCheckView(C01Input):
    contract_name = "MemoryCheck"


class MemoryCheckAnswers(C01Input):
    contract_name = "MemoryCheckAnswers"


@dataclass(frozen=True)
class ShiftCard:
    """Незакрытая карточка смены глазами проверки: что обучаемый услышал и что отметил."""

    label: str
    state: str
    heard: tuple[tuple[str, UUID], ...]


def _names(ids: list[UUID], names: dict[UUID, str]) -> list[str]:
    return [names[item] for item in ids]


def build_questions(
    available: list[tuple[UUID, str]], busy: set[UUID], cards: list[ShiftCard]
) -> list[dict[str, Any]]:
    """Три вопроса прототипа A с верными ответами на этот момент.

    Свободна — доступная бригада занятия, не направленная на незакрытую карточку (как табло
    сил). На месте — услышан её доклад о прибытии или о работах и не услышан о завершении
    или отказе. Не отмечено — по карточке услышан доклад этапа дальше её статуса.
    """
    names = dict(available)
    free = [brigade for brigade, _ in available if brigade not in busy]
    stages: dict[UUID, set[str]] = {}
    for card in cards:
        for stage, brigade in card.heard:
            stages.setdefault(brigade, set()).add(stage)
    on_scene = [
        brigade
        for brigade, _ in available
        if stages.get(brigade, set()) & _ON_SCENE and not stages.get(brigade, set()) & _LEFT
    ]
    behind: list[tuple[ShiftCard, str]] = []
    for card in cards:
        if not card.heard:
            continue
        stage = max((item for item, _ in card.heard), key=lambda item: _ORDER.get(item, 0))
        if _ORDER.get(stage, 0) > _ORDER.get(card.state, 0):
            behind.append((card, stage))
    count_options = [str(number) for number in range(max(3, len(available)) + 1)]
    return [
        {
            "key": "free_brigades",
            "text": "Сколько бригад вашей службы свободно прямо сейчас?",
            "options": count_options,
            "multiple": False,
            "answer": [str(len(free))],
            "why": (
                f"Свободно: {len(free)} — {', '.join(_names(free, names))}."
                if free
                else "Свободных нет: все бригады на ваших карточках."
            ),
        },
        {
            "key": "on_scene",
            "text": "Какие бригады уже на месте?",
            "options": [name for _, name in available] + [NONE_ON_SCENE],
            "multiple": True,
            "answer": _names(on_scene, names) or [NONE_ON_SCENE],
            "why": (
                f"На месте: {', '.join(_names(on_scene, names))}."
                if on_scene
                else "Пока ни одна бригада не доложила о прибытии."
            ),
        },
        {
            "key": "unreported",
            "text": "По какой карточке доклад бригады ещё не отмечен статусом?",
            "options": [card.label for card in cards] + [ALL_MARKED],
            "multiple": True,
            "answer": [card.label for card, _ in behind] or [ALL_MARKED],
            "why": (
                "Доклад не отмечен статусом: "
                + "; ".join(f"{card.label} — «{_STAGE_NAMES[stage]}»" for card, stage in behind)
                + "."
                if behind
                else "Каждый услышанный доклад отмечен статусом в карточке."
            ),
        },
    ]


def score(questions: list[dict[str, Any]], answers: list[list[str]]) -> int:
    """Сколько вопросов верно: выбран ровно набор верных вариантов."""
    return sum(
        set(given) == set(question["answer"])
        for question, given in zip(questions, answers, strict=True)
    )


def _conflict(code: str, message: str) -> HTTPException:
    return HTTPException(409, {"code": code, "message": message, "details": {}})


def _time(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


async def _shift(request: Request, session_id: UUID) -> tuple[Any, Any, list[Any]]:
    """Идущая финальная смена обучаемого и её карточки (строки Card + источник) по порядку."""
    db = request.state.db
    lesson = await repo.get_session(db, session_id)
    participant = (
        next((item for item in lesson.participants if item.user_id == request.state.user.id), None)
        if lesson is not None
        else None
    )
    if lesson is None or participant is None:
        raise HTTPException(404, "Занятие не найдено.")
    if not (lesson.settings_snapshot or {}).get("final_shift"):
        raise _conflict("memory_check_unavailable", "Проверка памяти — только в финальной смене.")
    rows = list(
        await db.execute(
            select(Card, Scenario.card)
            .join(Assignment, Assignment.id == Card.assignment_id)
            .join(Scenario, Scenario.id == Assignment.scenario_id)
            .where(
                Assignment.session_id == lesson.id,
                Assignment.participant_id == participant.id,
                Assignment.cancelled_at.is_(None),
            )
            .order_by(Card.appeared_at, Card.id)
        )
    )
    return lesson, participant, rows


async def _journal(request: Request, card_id: UUID) -> dict[str, CardEvent]:
    events = await request.state.db.scalars(
        select(CardEvent).where(
            CardEvent.card_id == card_id,
            CardEvent.actor_id == request.state.user.id,
            CardEvent.type.in_((CHECK, ANSWER)),
        )
    )
    return {event.type: event for event in events}


def _view(card_id: UUID, journal: dict[str, CardEvent]) -> MemoryCheckView:
    check = journal[CHECK]
    questions = check.payload["questions"]
    answer = journal.get(ANSWER)
    result = None
    if answer is not None:
        result = {
            "answers": answer.payload["answers"],
            "correct": [question["answer"] for question in questions],
            "why": [question["why"] for question in questions],
            "score": answer.payload["score"],
            "total": answer.payload["total"],
            "answered_at": _time(answer.server_ts),
        }
    return MemoryCheckView(
        {
            "card_id": str(card_id),
            "shown_at": _time(check.server_ts),
            "questions": [{key: question[key] for key in SHOWN} for question in questions],
            "result": result,
        }
    )


async def _write(
    request: Request, session_id: UUID, card_id: UUID, kind: str, payload: dict[str, Any]
) -> None:
    """Служебная запись журнала (как `status_denied`): автор — обучаемый, ключ повтора —
    из занятия, поэтому одновременный второй запрос вторую запись не создаёт."""
    now = datetime.now(UTC)
    user_id = request.state.user.id
    await request.state.db.execute(
        insert(CardEvent)
        .values(
            card_id=card_id,
            actor_id=user_id,
            client_event_id=uuid5(session_id, f"{kind}:{user_id}"),
            client_ts=now,
            server_ts=now,
            clock_offset_ms=request.app.state.realtime.offset_for(user_id),
            type=kind,
            payload=payload,
        )
        .on_conflict_do_nothing(index_elements=["actor_id", "client_event_id"])
    )
    await notify(request.state.db, "card.updated", card_id)


async def start(request: Request, session_id: UUID) -> MemoryCheckView:
    db = request.state.db
    request.state.entity = "session"
    request.state.entity_id = str(session_id)
    lesson, participant, rows = await _shift(request, session_id)
    if not rows:
        raise _conflict("memory_check_early", "Карточек смены ещё нет.")
    anchor: Card = rows[0][0]
    journal = await _journal(request, anchor.id)
    if CHECK in journal:
        return _view(anchor.id, journal)
    if lesson.status != "running":
        raise _conflict("session_not_running", "Проверка памяти — только во время смены.")
    roster = await brigade_roster(db, anchor)
    busy = set(roster.busy)
    open_rows = [
        (card, source)
        for card, source in rows
        if card.closed_at is None and card.interrupted_at is None
    ]
    if any(card.id == anchor.id for card, _ in open_rows):
        busy |= set(
            await db.scalars(select(CardBrigade.brigade_id).where(CardBrigade.card_id == anchor.id))
        )
    # Result умеет keys(): dict() принял бы его за словарь — берём строки списком.
    rows_names = await db.execute(
        select(Brigade.id, Brigade.name).where(Brigade.id.in_(roster.available))
    )
    names = dict(list(rows_names.tuples()))
    available = [(brigade, names[brigade]) for brigade in roster.available if brigade in names]
    cards = [
        ShiftCard(
            label=f"{card.number} — {(source or {}).get('incident_class') or 'происшествие'}",
            state=card.state,
            heard=tuple(await heard_reports(db, card)),
        )
        for card, source in open_rows
    ]
    questions = build_questions(available, busy, cards)
    await _write(request, session_id, anchor.id, CHECK, {"questions": questions})
    return _view(anchor.id, await _journal(request, anchor.id))


async def answer(request: Request, session_id: UUID, body: MemoryCheckAnswers) -> MemoryCheckView:
    request.state.entity = "session"
    request.state.entity_id = str(session_id)
    lesson, _, rows = await _shift(request, session_id)
    journal = await _journal(request, rows[0][0].id) if rows else {}
    if CHECK not in journal:
        raise _conflict("memory_check_missing", "Проверки памяти в этой смене не было.")
    anchor_id = rows[0][0].id
    if ANSWER in journal:
        return _view(anchor_id, journal)
    if lesson.status != "running":
        raise _conflict("session_not_running", "Проверка памяти — только во время смены.")
    questions = journal[CHECK].payload["questions"]
    answers = [list(dict.fromkeys(given)) for given in body.root["answers"]]
    if len(answers) != len(questions) or any(
        not set(given) <= set(question["options"]) or (not question["multiple"] and len(given) > 1)
        for question, given in zip(questions, answers, strict=False)
    ):
        raise HTTPException(
            422,
            {
                "code": "validation_error",
                "message": "Ответы не соответствуют вопросам проверки.",
                "details": {},
            },
        )
    payload = {"answers": answers, "score": score(questions, answers), "total": len(questions)}
    await _write(request, session_id, anchor_id, ANSWER, payload)
    return _view(anchor_id, await _journal(request, anchor_id))
