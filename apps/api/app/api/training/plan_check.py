"""Карточку можно закрыть: у бригады есть доклады до завершающего статуса (эталон, 1.5).

Одно правило для тренировки, подбора сценариев преподавателю («Подобрать по службе и
уровню») и проверки каталога при seed: без доклада о завершении статус «Работы завершены»
сервер не примет (`status_evidence`), и обучаемый ждёт доклада, которого нет.
"""

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.training.status_evidence import justified_state
from app.core.models import Scenario, ScenarioTrainingPlan

# Эталон, раздел 1.5: пауза между докладами — не больше 40 секунд реального времени.
MAX_REPORT_PAUSE_S = 40
# Статусы, которые ставят только по докладу бригады. «Начало реагирования» — по разговору
# с бригадой («Принял, выезжаем», эталон, раздел 3), отдельный доклад ему не нужен.
REPORTED_STATES = ("arrived", "working", "completed", "refused")


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


def missing_reports(scenario: Scenario, messages: list[dict[str, Any]]) -> list[str]:
    """Статусы эталонного хода, для которых в плане нет доклада; пусто — план полный.

    Ход, который кончается решением диспетчера («Не принята», «Передана»), бригады не
    требует: такую карточку закрывают без докладов.
    """
    flow = [state for state in scenario.reference.get("expected_flow", []) if state != "added"]
    if not flow or flow[-1] not in REPORTED_STATES:
        return []
    justified = {justified_state(item, scenario.id) for item in messages}
    return [state for state in flow if state in REPORTED_STATES and state not in justified]


def report_pauses(messages: list[dict[str, Any]]) -> list[int]:
    """Сколько секунд обучаемый ждёт каждого доклада плана (`gating.schedule_reports`).

    Доклад с requires_state готов через available_after_s после статуса, которого ждёт;
    без него — через available_after_s от отправки бригады, то есть после предыдущего
    такого же доклада на разницу их отсчётов. Задержки из-за ошибок обучаемого (последствия
    событий DT-10) — не пауза плана.
    """
    pauses = []
    previous = 0
    for item in messages:
        after = int(item["available_after_s"])
        if item.get("requires_state"):
            pauses.append(after)
        else:
            pauses.append(after - previous)
            previous = after
    return pauses


async def closable(db: AsyncSession, scenario: Scenario) -> bool:
    return not missing_reports(scenario, await plan_messages(db, scenario))
