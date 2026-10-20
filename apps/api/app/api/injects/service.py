"""Вводные преподавателя (DT-06, #69).

Вводная — то же событие плана сценария (`TrainingPlan.events`), поданное вручную
(contracts/scenario-events.md, раздел 4 и «Принято 08.10»). Подаётся по виду события:
у разных обучаемых разные сценарии, а преподаватель выбирает «тревога бригады» — сервер у
каждого адресата находит в открытой карточке событие этого вида с `injectable` или
`trigger.on = inject`, которое ещё не срабатывало, и вызывает `fire_event_now`. Оценка и
разбор — критерий `brigade_work` (evalcore), вводная там помечена источником `inject`.
"""

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from fastapi import HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.injects import schemas
from app.api.notifications import notify
from app.api.sessions.service import ensure_owner
from app.api.training.scenario_events import (
    EventNotApplicable,
    card_events_plan,
    fire_event_now,
)
from app.core.models import (
    Assignment,
    Card,
    Participant,
    ScenarioEventFiring,
    Session,
    User,
)

TITLES: dict[str, str] = {
    "alarm": "Тревога бригады",
    "clarify": "Бригада уточняет",
    "request_service": "Бригада просит другую службу",
    "silence": "Бригада молчит",
    "readback_error": "Бригада повторила адрес с ошибкой",
}


def injectable(event: dict[str, Any]) -> bool:
    return bool(event.get("injectable")) or event["trigger"]["on"] == "inject"


async def _session(request: Request, session_id: UUID, *, lock: bool) -> Session:
    query = select(Session).where(Session.id == session_id)
    row = await request.state.db.scalar(query.with_for_update() if lock else query)
    if row is None:
        raise HTTPException(404, "Занятие не найдено.")
    ensure_owner(row, request.state.user)
    return row


async def _people(db: AsyncSession, session_id: UUID) -> dict[UUID, tuple[int, str, UUID]]:
    """Обучаемый (user_id — так участник называется во всём API, как в назначениях) →
    (рабочее место, имя, id строки участия)."""
    rows = await db.execute(
        select(Participant.user_id, Participant.workstation_id, User.full_name, Participant.id)
        .join(User, User.id == Participant.user_id)
        .where(Participant.session_id == session_id)
    )
    return {user: (place, name, row) for user, place, name, row in rows.tuples()}


async def _open_cards(db: AsyncSession, session_id: UUID, *, lock: bool) -> list[tuple[Card, UUID]]:
    """Открытые карточки занятия с участником. Блокировки — в порядке worker:
    назначения, затем карточки (app/worker/training.py, TrainingScheduler.tick)."""
    assignments = select(Assignment).where(Assignment.session_id == session_id)
    owners = {
        row.id: row.participant_id
        for row in await db.scalars(
            (assignments.with_for_update() if lock else assignments).order_by(Assignment.id)
        )
    }
    cards = select(Card).where(
        Card.assignment_id.in_(owners),
        Card.closed_at.is_(None),
        Card.interrupted_at.is_(None),
    )
    rows = await db.scalars((cards.with_for_update() if lock else cards).order_by(Card.id))
    return [(card, owners[card.assignment_id]) for card in rows]


async def _fired_ids(db: AsyncSession, card_id: UUID) -> set[UUID]:
    return set(
        await db.scalars(
            select(ScenarioEventFiring.event_id).where(ScenarioEventFiring.card_id == card_id)
        )
    )


async def overview(request: Request, session_id: UUID) -> schemas.InjectOverview:
    db = request.state.db
    session = await _session(request, session_id, lock=False)
    people = await _people(db, session.id)
    counts: dict[str, int] = {}
    if session.status == "running":
        for card, _ in await _open_cards(db, session.id, lock=False):
            _, events = await card_events_plan(db, card)
            done = await _fired_ids(db, card.id)
            kinds = {
                event["kind"]
                for event in events
                if injectable(event) and UUID(event["id"]) not in done
            }
            for kind in kinds:
                counts[kind] = counts.get(kind, 0) + 1
    options = [
        schemas.InjectOption.model_validate({"kind": kind, "title": TITLES[kind], "cards": n})
        for kind, n in sorted(counts.items(), key=lambda item: list(TITLES).index(item[0]))
        if kind in TITLES
    ]
    rows = await db.execute(
        select(ScenarioEventFiring, Card, Assignment.participant_id)
        .join(Card, Card.id == ScenarioEventFiring.card_id)
        .join(Assignment, Assignment.id == Card.assignment_id)
        .where(Assignment.session_id == session.id, ScenarioEventFiring.source == "inject")
        .order_by(ScenarioEventFiring.fired_at.desc(), ScenarioEventFiring.id)
    )
    fired: list[schemas.InjectFiring] = []
    for firing, card, participant_id in rows.tuples():
        _, events = await card_events_plan(db, card)
        kind = next(
            (event["kind"] for event in events if UUID(event["id"]) == firing.event_id), None
        )
        if kind not in TITLES:
            continue
        user = next((u for u, item in people.items() if item[2] == participant_id), None)
        if user is None:
            continue
        workstation, name, _ = people[user]
        fired.append(
            schemas.InjectFiring.model_validate(
                {
                    "id": firing.id,
                    "kind": kind,
                    "title": TITLES[kind],
                    "card_id": card.id,
                    "card_number": card.number,
                    "participant_id": user,
                    "workstation": workstation,
                    "trainee_name": name,
                    "fired_at": firing.fired_at,
                }
            )
        )
    return schemas.InjectOverview(options=options, fired=fired)


async def inject(
    request: Request, session_id: UUID, body: schemas.InjectInput
) -> schemas.InjectReceipt:
    db = request.state.db
    request.state.entity = "session"
    request.state.entity_id = str(session_id)
    # Блокировки — в порядке worker: занятие, назначения, карточки.
    session = await _session(request, session_id, lock=True)
    if session.status != "running":
        raise HTTPException(409, "Вводную можно подать только в идущее занятие.")
    people = await _people(db, session.id)
    targets = list(people) if body.targets == "all" else list(dict.fromkeys(body.targets))
    unknown = [str(pid) for pid in targets if pid not in people]
    if unknown:
        raise HTTPException(422, "Среди адресатов есть не участники этого занятия.")
    cards = await _open_cards(db, session.id, lock=True)
    now = datetime.now(UTC)
    results: list[schemas.InjectResult] = []
    for participant_id in sorted(targets, key=lambda pid: people[pid][0]):
        workstation, name, row_id = people[participant_id]
        own = [card for card, owner in cards if owner == row_id]
        reason = "Нет открытой карточки." if not own else "В сценарии карточки нет такого события."
        fired_card: Card | None = None
        for card in own:
            _, events = await card_events_plan(db, card)
            for event in events:
                if event["kind"] != body.kind or not injectable(event):
                    continue
                try:
                    await fire_event_now(
                        db, card, UUID(event["id"]), injected_by=request.state.user.id, now=now
                    )
                except EventNotApplicable as exc:
                    reason = str(exc)
                    continue
                fired_card = card
                break
            if fired_card is not None:
                break
        if fired_card is not None:
            # Реплика события — сразу, не ждать тика worker: бригада звонит или говорит
            # в идущем разговоре (как после статуса, app/api/cards/service.py).
            from app.worker.training import deliver_messages, ring_brigades

            await deliver_messages(db, fired_card, now)
            await ring_brigades(db, fired_card, now)
            await notify(db, "card.updated", fired_card.id)
        results.append(
            schemas.InjectResult.model_validate(
                {
                    "participant_id": participant_id,
                    "workstation": workstation,
                    "trainee_name": name,
                    "status": "fired" if fired_card else "not_applicable",
                    "card_id": fired_card.id if fired_card else None,
                    "card_number": fired_card.number if fired_card else None,
                    "reason": None if fired_card else reason,
                }
            )
        )
    request.state.audit_after = {
        "kind": body.kind,
        "fired": sum(1 for result in results if result.status == "fired"),
        "targets": len(results),
    }
    return schemas.InjectReceipt(kind=body.kind, results=results)
