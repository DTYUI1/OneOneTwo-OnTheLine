"""Личная тренировка обучаемого: обучающее упражнение, которое можно проходить сколько угодно.

Тренировка — обычное занятие (`Session.kind = "practice"`) с одним назначением обучающего
сценария службы: карточку выдаёт тот же планировщик, действия и оценка идут тем же путём,
что на занятии преподавателя. Отличия только в владельце (сам обучаемый — поэтому
преподаватель её не видит в списках и отчётах) и в подсказках (hints_level = 1).

Ступени (29.09, evalcore/progress.py): `?step=N` — тренировка ступени. Ступень 1 — то же
обучающее упражнение с подсказчиком; 2–4 — случайный одобренный сценарий своей службы
уровня ступени, без подсказчика; 4 — две карточки параллельно. Закрытая ступень — 409.
В тренировку идут только сценарии с докладами бригады (`playable`): для ступеней 2–3 это
готовые происшествия `app.seed.practice`.
"""

import random
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5

from evalcore.progress import Step, step_by_number, step_progress  # type: ignore[import-untyped]
from fastapi import HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.c01 import DEFAULT_TIMING_POLICY
from app.api.foundation.repo import training_settings
from app.api.foundation.schemas import with_comment_defaults
from app.api.notifications import notify
from app.api.sessions import schemas
from app.api.sessions.lifecycle import stop_attempts
from app.api.sessions.service import serialize
from app.core.models import (
    Assignment,
    Participant,
    Scenario,
    ScenarioTrainingPlan,
    Session,
    TraineeRating,
)

PRACTICE_TITLE = "Тренировка: полный цикл карточки"
# На ступени параллельной работы вторая карточка приходит, пока идёт первая.
PARALLEL_GAP = timedelta(seconds=45)


def tutorial_scenario_id(service_id: str) -> UUID:
    """Стабильный id обучающего сценария службы (создаёт `python -m app.seed.training`)."""
    return uuid5(NAMESPACE_URL, f"arm112:c04:tutorial:{service_id}")


async def tutorial_scenario(request: Request, service_id: str | None) -> Scenario:
    """Упражнение своей службы; если для неё нет — первое загруженное."""
    db = request.state.db
    if service_id is not None:
        own = await db.get(Scenario, tutorial_scenario_id(service_id))
        if own is not None and own.status == "approved":
            return own
    candidates = list(
        await db.scalars(
            select(Scenario)
            .where(Scenario.status == "approved", Scenario.origin == "template")
            .order_by(Scenario.target_service_id)
        )
    )
    for scenario in candidates:
        if scenario.id == tutorial_scenario_id(scenario.target_service_id):
            return scenario
    raise HTTPException(
        422,
        {
            "code": "practice_unavailable",
            "message": "Обучающее упражнение не загружено. Попросите администратора "
            "выполнить загрузку учебных сценариев (python -m app.seed.training).",
            "details": {},
        },
    )


def step_conflict(code: str, message: str) -> HTTPException:
    return HTTPException(409, {"code": code, "message": message, "details": {}})


def parallel_scenario_id(service_id: str) -> UUID:
    """Сценарий параллельной смены (`app.seed.training`, PARALLEL_KEY): для занятия с двумя
    карточками — бригада едет и работает по минуте, в одиночной тренировке это пауза."""
    return uuid5(NAMESPACE_URL, f"arm112:c04:parallel:{service_id}")


async def plan_messages(db: AsyncSession, scenario: Scenario) -> list[dict[str, Any]]:
    """Доклады учебного плана текущей версии сценария; пусто — бригада молчит."""
    plan = await db.scalar(
        select(ScenarioTrainingPlan.plan)
        .where(
            ScenarioTrainingPlan.scenario_id == scenario.id,
            ScenarioTrainingPlan.scenario_version <= scenario.version,
        )
        .order_by(ScenarioTrainingPlan.scenario_version.desc())
        .limit(1)
    )
    return list(plan["messages"]) if plan else []


async def playable(db: AsyncSession, candidates: list[Scenario]) -> list[Scenario]:
    """Сценарии, которые проходятся без преподавателя: у бригады есть доклады.

    Без плана бригада на звонок не докладывает — у обучаемого «ничего не происходит»
    (находка 29.09: golden-сценарии на ступени 2). Если есть сценарии, где каждый доклад
    ждёт статуса диспетчера (requires_state, как в упражнении), берём только их.
    """
    planned: list[Scenario] = []
    gated: list[Scenario] = []
    for item in candidates:
        messages = await plan_messages(db, item)
        if not messages:
            continue
        planned.append(item)
        if all(message.get("requires_state") for message in messages):
            gated.append(item)
    return gated or planned


async def step_pool(db: AsyncSession, step: Step, service_id: str | None) -> list[Scenario]:
    """Из чего выбирает тренировка ступени 2–4: своя служба, уровень ступени, не упражнение
    и не параллельная смена, с докладами бригады."""
    from app.api.progress.service import is_tutorial

    query = select(Scenario).where(Scenario.status == "approved", Scenario.level.in_(step.levels))
    if service_id is not None:
        query = query.where(Scenario.target_service_id == service_id)
    query = query.order_by(Scenario.id)
    return await playable(
        db,
        [
            item
            for item in await db.scalars(query)
            if not is_tutorial(item) and item.id != parallel_scenario_id(item.target_service_id)
        ],
    )


async def step_scenarios(request: Request, step: Step, service_id: str | None) -> list[Scenario]:
    """Сценарии тренировки ступени (`step_pool`); по возможности не те, что были в прошлой
    тренировке."""
    db = request.state.db
    pool = await step_pool(db, step, service_id)
    if not pool:
        raise HTTPException(
            422,
            {
                "code": "practice_unavailable",
                "message": f"Для ступени {step.number} нет одобренных сценариев вашей службы. "
                "Попросите преподавателя добавить их в студии сценариев.",
                "details": {},
            },
        )
    last = set(
        await db.scalars(
            select(Assignment.scenario_id)
            .join(Session, Session.id == Assignment.session_id)
            .where(Session.teacher_id == request.state.user.id, Session.kind == "practice")
            .order_by(Session.started_at.desc())
            .limit(step.parallel)
        )
    )
    fresh = [item for item in pool if item.id not in last] or pool
    random.shuffle(fresh)
    # Не хватает разных — повторяем: параллельной работе важнее число карточек.
    return [fresh[index % len(fresh)] for index in range(step.parallel)]


async def start_practice(request: Request, step_number: int | None = None) -> schemas.Session:
    db = request.state.db
    user = request.state.user
    request.state.entity = "session"
    step = None
    if step_number is not None:
        if not 1 <= step_number <= 4:
            raise HTTPException(422, "Ступени — с 1 по 4.")
        from app.api.progress.service import trainee_attempts

        progress = step_progress(await trainee_attempts(db, user.id))
        if not progress[step_number - 1].unlocked:
            raise step_conflict(
                "step_locked",
                f"Ступень {step_number} откроется, когда будет пройдена ступень {step_number - 1}.",
            )
        step = step_by_number(step_number)
    # Двойной щелчок не должен породить две тренировки.
    await db.execute(
        select(func.pg_advisory_xact_lock(func.hashtextextended(f"practice:{user.id}", 0)))
    )
    lesson_running = await db.scalar(
        select(Session.id)
        .join(Participant, Participant.session_id == Session.id)
        .where(
            Participant.user_id == user.id,
            Session.kind == "lesson",
            Session.status == "running",
        )
        .limit(1)
    )
    if lesson_running is not None:
        raise HTTPException(
            409,
            {
                "code": "lesson_running",
                "message": "Идёт занятие преподавателя. Тренировка доступна после него.",
                "details": {},
            },
        )
    settings_row = await training_settings(db)
    if settings_row is None:
        raise HTTPException(503, "Начальные настройки не загружены. Запустите seed.")
    if step is None or step.tutorial:
        scenarios = [await tutorial_scenario(request, user.dds_service_id)]
    else:
        scenarios = await step_scenarios(request, step, user.dds_service_id)
    scenario = scenarios[0]
    now = datetime.now(UTC)
    # Прежняя тренировка закрывается так же, как занятие: открытая карточка — прервана.
    previous = await db.scalars(
        select(Session)
        .where(
            Session.teacher_id == user.id,
            Session.kind == "practice",
            Session.status == "running",
        )
        .order_by(Session.id)
        .with_for_update()
    )
    for old in previous.all():
        await stop_attempts(db, old.id, now)
        old.status, old.finished_at = "finished", now
        await notify(db, "session.finished", old.id)
    # Практика — учебный режим: подсказки орфографии включены всегда.
    # Подсказчик — только в упражнении; на ступенях 2–4 обучаемый работает сам.
    guided = step is None or step.tutorial
    settings = {
        **with_comment_defaults(settings_row.value),
        "hints_level": 1 if guided else 0,
        "spelling_hints": True,
        "parallel_cards": step.parallel if step else 1,
    }
    lesson = Session(
        teacher_id=user.id,
        title=PRACTICE_TITLE
        if step is None
        else f"Тренировка: ступень {step.number} — {step.title}",
        status="running",
        kind="practice",
        started_at=now,
        finished_at=None,
        settings_snapshot=settings,
        timing_policy={
            **DEFAULT_TIMING_POLICY,
            "reaction_normative_s": settings["reaction_normative_s"],
            "handling_normative_s": settings["handling_normative_s"],
        },
    )
    db.add(lesson)
    await db.flush()
    rating = await db.get(TraineeRating, user.id)
    participant = Participant(
        session_id=lesson.id,
        user_id=user.id,
        workstation_id=user.workstation_number or 1,
        # Служба участия — служба упражнения: бригады и номера берутся из неё.
        dds_service_id=scenario.target_service_id,
        # Уровень участника ограничивает одновременные карточки: для ступени 4 — две.
        level=max(step.levels) if step and not step.tutorial else 1,
        rating_at_start=rating.theta if rating else 0.0,
    )
    db.add(participant)
    await db.flush()
    for order, item in enumerate(scenarios, start=1):
        at = now + PARALLEL_GAP * (order - 1)
        db.add(
            Assignment(
                session_id=lesson.id,
                participant_id=participant.id,
                scenario_id=item.id,
                scenario_version=item.version,
                order=order,
                planned_at=at,
                due_at=at,
                status="pending",
            )
        )
    await db.flush()
    await db.refresh(lesson, attribute_names=["participants"])
    result = serialize(lesson)
    request.state.entity_id = str(lesson.id)
    request.state.audit_after = result.model_dump(mode="json")
    await notify(db, "session.started", lesson.id)
    return result
