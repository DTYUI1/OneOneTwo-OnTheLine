"""Автовыдача сгенерированных сценариев (GP-14): тренировка без преподавателя.

Когда тренировке не хватает готовых сценариев, которых обучаемый ещё не проходил, сервер
сам готовит новый по службе, уровню ступени и слабому месту обучаемого (`app.seed.generator`,
шаблонный путь — без сети и модели) и сразу выдаёт его. Сценарий попадает черновиком в общий
пакет «Сгенерировано для тренировок»: преподаватель видит его в студии сценариев и утверждает
или отклоняет (отклонённый — в архиве и больше не выдаётся). Черновик из пакета тренировка
выдаёт и до утверждения: так задумано, ИИ работает без участия преподавателя.
"""

import random
from functools import lru_cache
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from app.core.config import ROOT
from app.core.models import Scenario, ScenarioPack, ScenarioPackItem, Service, Street, User
from app.seed.generator import generate_checked
from app.seed.scenarios import audio_resolver, load_catalog, scenario_uuid, store_scenario

GENERATED_PACK_ID = uuid5(NAMESPACE_URL, "arm112:pack:generated")
GENERATED_PACK_TITLE = "Сгенерировано для тренировок"
VOICES = ROOT / "data" / "voices"
# Сколько улиц справочника предлагать генератору за раз.
STREET_SAMPLE = 50


@lru_cache(maxsize=4)
def _catalog(services: frozenset[str]) -> tuple[dict[str, Any], ...]:
    return tuple(load_catalog(set(services)).scenarios)


def issuable() -> ColumnElement[bool]:
    """Сценарий можно выдать в тренировку: утверждён или ждёт проверки в пакете генерации."""
    in_pack = select(ScenarioPackItem.scenario_id).where(
        ScenarioPackItem.pack_id == GENERATED_PACK_ID
    )
    return or_(
        Scenario.status == "approved",
        and_(Scenario.status == "draft", Scenario.id.in_(in_pack)),
    )


async def street_sample(db: AsyncSession) -> list[dict[str, str]]:
    rows = await db.execute(
        select(Street.name, Street.okrug, Street.district)
        .where(Street.okrug != "", Street.district != "")
        .order_by(func.random())
        .limit(STREET_SAMPLE)
    )
    return [{"name": name, "okrug": okrug, "district": district} for name, okrug, district in rows]


async def _pack(db: AsyncSession) -> ScenarioPack:
    pack = await db.get(ScenarioPack, GENERATED_PACK_ID)
    if pack is None:
        pack = ScenarioPack(
            id=GENERATED_PACK_ID,
            title=GENERATED_PACK_TITLE,
            status="draft",
            origin="template",
            created_by=None,
        )
        db.add(pack)
        await db.flush()
    return pack


async def issue_generated(
    db: AsyncSession,
    *,
    service_id: str,
    level: int,
    focus: str | None = None,
    seed: int | None = None,
    llm: Any = None,
) -> Scenario | None:
    """Подготовить, проверить и записать сценарий; None — не из чего или не прошёл проверку."""
    teacher = await db.scalar(
        select(User.id)
        .where(User.role == "teacher", User.is_active.is_(True))
        .order_by(User.login)
        .limit(1)
    )
    if teacher is None:
        return None
    services = frozenset(await db.scalars(select(Service.id)))
    catalog = list(_catalog(services))
    rng = random.SystemRandom()
    for _ in range(3):
        try:
            result = await generate_checked(
                catalog,
                set(services),
                service_id=service_id,
                level=level,
                seed=seed if seed is not None else rng.randrange(2**32),
                streets=await street_sample(db),
                focus=focus,
                llm=llm,
            )
        except ValueError:
            return None
        if result is None:
            continue
        data, origin = result
        if await db.get(Scenario, scenario_uuid(data)) is not None:
            seed = None
            continue
        # Порядок в пакете уникален: две тренировки сразу не должны взять один номер.
        await db.execute(
            select(func.pg_advisory_xact_lock(func.hashtextextended("pack:generated", 0)))
        )
        await _pack(db)
        audio, _silent = audio_resolver(db, VOICES)
        scenario = await store_scenario(
            db,
            data,
            audio,
            plan_author_id=teacher,
            author_id=None,
            status="draft",
            origin=origin,
        )
        order = await db.scalar(
            select(func.coalesce(func.max(ScenarioPackItem.order), 0)).where(
                ScenarioPackItem.pack_id == GENERATED_PACK_ID
            )
        )
        db.add(
            ScenarioPackItem(
                pack_id=GENERATED_PACK_ID, scenario_id=scenario.id, order=(order or 0) + 1
            )
        )
        await db.flush()
        return scenario
    return None
