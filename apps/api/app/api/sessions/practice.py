"""Личная тренировка обучаемого: обучающее упражнение, которое можно проходить сколько угодно.

Тренировка — обычное занятие (`Session.kind = "practice"`) с одним назначением обучающего
сценария службы: карточку выдаёт тот же планировщик, действия и оценка идут тем же путём,
что на занятии преподавателя. Отличия только в владельце (сам обучаемый — поэтому
преподаватель её не видит в списках и отчётах) и в подсказках (hints_level = 1).

Ступени (29.09, evalcore/progress.py): `?step=N` — тренировка ступени. Ступень 1 — то же
обучающее упражнение с подсказчиком; 2–3 — случайный одобренный сценарий своей службы
уровня ступени, без подсказчика; 4 — параллельная смена (HQ-032): два разных проработанных
сценария уровней 1–2 своей службы, вторая карточка приходит через `PARALLEL_GAP` после
первой; 5 — финальная смена (HQ-033): три проработанных сценария каталога своей службы
разных происшествий (`final_scenarios`), карточки через `FINAL_GAP` одна за другой, вызов
бригады подписан только бригадой (`settings.final_shift`). Закрытая ступень — 409.
В тренировку идут только сценарии с докладами бригады до завершающего статуса
(`playable`): для ступеней 2–3 это готовые происшествия `app.seed.practice`.

Повтор (TC-11): `?scenario_id=…` — незачтённый сценарий из «Моего пути»
(`app.api.progress.repeats`); ступень — по его уровню, на ступени 4 вторая карточка — как
обычно. Не из списка повторов — 409 repeat_unavailable.

Каталог сценариев (17.10): `GET /practice/catalog` — все проработанные сценарии (с событиями
и ветками, `catalog_trains`), `?scenario=<id>` — тренировка именно этого сценария за
диспетчера его службы, без подсказчика.
"""

import json
import random
import re
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from functools import cache
from typing import Any, Literal
from uuid import NAMESPACE_URL, UUID, uuid5

from evalcore.defaults import DEFAULT_PHONE_CONTACTS, phone_contacts  # type: ignore[import-untyped]
from evalcore.progress import (  # type: ignore[import-untyped]
    STEPS,
    Step,
    step_by_number,
    step_progress,
)
from fastapi import HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.c01 import DEFAULT_TIMING_POLICY
from app.api.foundation.repo import training_settings
from app.api.foundation.schemas import with_comment_defaults
from app.api.notifications import notify
from app.api.progress.advice import recent_scores, weak_spots
from app.api.sessions import schemas
from app.api.sessions.lifecycle import stop_attempts
from app.api.sessions.service import serialize
from app.api.training.autogen import issuable, issue_generated
from app.api.training.plan_check import missing_reports, plan_messages
from app.core.config import ROOT
from app.core.models import (
    Assignment,
    Card,
    Participant,
    Scenario,
    ScenarioTrainingPlan,
    Service,
    Session,
    TraineeRating,
)

PRACTICE_TITLE = "Тренировка: полный цикл карточки"
# На ступени параллельной работы вторая карточка приходит, пока идёт первая: первая к
# этому времени принята и бригада выехала (норматив принятия 30 с), а до её доклада о
# прибытии ещё идёт пауза плана. [ASSUMPTION] HQ-032: 45 с, как в смене до HQ-032.
PARALLEL_GAP = timedelta(seconds=45)
# Уровень участника на ступени параллельной работы: пара — из сценариев уровней 1–2, но фон и
# прочая нагрузка — уровня 4, как у ступени 4 до HQ-032.
PARALLEL_LEVEL = 4
# Финальная смена (HQ-033): карточки приходят чаще, чем на ступени 4, — к третьей первая ещё
# в работе, доклады и вызовы бригад пересекаются. [ASSUMPTION] 20 с: принять карточку
# (норматив 30 с) до прихода следующей не успеть — телефон перегружен с начала смены.
FINAL_GAP = timedelta(seconds=20)
# Номер заявителя в телефоне ДДС тренировки (`practice_phone_contacts`): следом за
# руководством 401–404, чтобы список читался одним рядом; занят — первый свободный.
PRACTICE_CALLER_NUMBERS = ("405", "406", "407", "408", "409")


# Голос учебных сценариев C-04 (`app.seed.training`): «bank» — записи банка озвучки
# ElevenLabs (проверка 17.10: без Piper). Прежние id без голоса — записи Piper, они в архиве.
AUDIO_VOICE = "bank"


def audio_scenario_id(key: str, service_id: str, voice: str | None = AUDIO_VOICE) -> UUID:
    """Стабильный id учебного сценария поколения `key` для службы."""
    name = f"{key}:{service_id}" if voice is None else f"{key}:{voice}:{service_id}"
    return uuid5(NAMESPACE_URL, f"arm112:c04:{name}")


def tutorial_scenario_id(service_id: str) -> UUID:
    """Стабильный id обучающего сценария службы (создаёт `python -m app.seed.training`)."""
    return audio_scenario_id("tutorial", service_id)


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
    return audio_scenario_id("parallel", service_id)


async def playable(db: AsyncSession, candidates: list[Scenario]) -> list[Scenario]:
    """Сценарии, которые проходятся без преподавателя: бригада докладывает до конца.

    Без полного плана обучаемый ждёт доклада, которого нет (находки 29.09 и 15.10:
    golden-сценарии без докладов, `plan_check`). Если есть сценарии, где каждый доклад
    ждёт статуса диспетчера (requires_state, как в упражнении), берём только их.
    """
    planned: list[Scenario] = []
    gated: list[Scenario] = []
    for item in candidates:
        messages = await plan_messages(db, item)
        if not messages or missing_reports(item, messages):
            continue
        planned.append(item)
        if all(message.get("requires_state") for message in messages):
            gated.append(item)
    return gated or planned


async def step_pool(db: AsyncSession, step: Step, service_id: str | None) -> list[Scenario]:
    """Из чего выбирает тренировка ступени 2–4: своя служба, уровень ступени, с докладами
    бригады и годный для случайного выбора (`practice_candidate`). Кроме утверждённых —
    сгенерированные черновики, ждущие проверки преподавателя (`autogen.issuable`).

    Сценарий с обязательным звонком заявителю в случайную выдачу не попадает
    (`needs_teacher_contact`): такой разговор обучаемый выбирает сам в каталоге, где видно,
    чему сценарий учит."""
    query = select(Scenario).where(issuable(), Scenario.level.in_(step.levels))
    if service_id is not None:
        query = query.where(Scenario.target_service_id == service_id)
    query = query.order_by(Scenario.id)
    return await playable(
        db,
        [
            item
            for item in await db.scalars(query)
            if practice_candidate(item) and not needs_teacher_contact(item)
        ],
    )


def practice_candidate(scenario: Scenario) -> bool:
    """Не учебный сценарий C-04 (упражнение, демо, параллельная смена — у них ровный доклад за
    докладом без событий; проверка 17.10: демо «Дубнинская, 1» выпадало на ступени 2, с HQ-032
    и на ступени 4 его нет — она собирает смену из проработанных сценариев) и не карточка
    связки 112 → ДДС: связку преподаватель назначает в занятии сам, со своим разбором ошибок
    оператора (DT-04)."""
    from app.seed.link112 import is_link_scenario
    from app.seed.training import AUDIO_GENERATIONS

    service = scenario.target_service_id
    c04 = {audio_scenario_id(item.key, service) for item in AUDIO_GENERATIONS}
    return scenario.id not in c04 and not is_link_scenario(scenario)


def needs_teacher_contact(scenario: Scenario) -> bool:
    """Эталон требует звонка абоненту, которого в телефоне ДДС по умолчанию нет (заявитель)."""
    reference = scenario.reference if isinstance(scenario.reference, dict) else {}
    call = reference.get("expected_call") or {}
    role = call.get("contact_role")
    return (
        call.get("required") is True
        and isinstance(role, str)
        and role not in {item["role"] for item in DEFAULT_PHONE_CONTACTS}
    )


def practice_phone_contacts(
    settings: Mapping[str, Any], scenarios: list[Scenario]
) -> dict[str, list[dict[str, Any]]]:
    """Абоненты телефона ДДС тренировки: заявитель там, где без него сценарий не пройти.

    На занятии номер заявителя включает преподаватель (рекомендации 16.10, п. 8) — в
    тренировке преподавателя нет, поэтому сценарий каталога со звонком заявителю
    (`needs_teacher_contact`) получает абонента «Заявитель» сам, номером 405 следом за
    руководством (401–404); номер занят — первый свободный из 406–409. Характер не задан: он
    берётся из сценария (`caller.character`). Служба, где такого сценария нет, в списке не
    появляется — у неё остаются `DEFAULT_PHONE_CONTACTS`; настроенный список своей службы
    тренировка сохраняет и лишь добавляет в него заявителя."""
    configured = settings.get("phone_contacts")
    base = dict(configured) if isinstance(configured, Mapping) else {}
    found: dict[str, list[dict[str, Any]]] = {}
    for scenario in scenarios:
        service_id = scenario.target_service_id
        if not needs_teacher_contact(scenario) or service_id in found:
            continue
        items = base.get(service_id)
        contacts: list[dict[str, Any]] = (
            [dict(item) for item in items]
            if isinstance(items, list)
            else [dict(contact) for contact in DEFAULT_PHONE_CONTACTS]
        )
        if any(item.get("role") == "caller" for item in contacts):
            continue
        taken = {str(item.get("number")) for item in contacts}
        number = next(
            (item for item in PRACTICE_CALLER_NUMBERS if item not in taken),
            None,
        )
        if number is None:
            continue
        found[service_id] = [*contacts, {"role": "caller", "name": "Заявитель", "number": number}]
    return found


def other_levels_first(candidates: list[Scenario], levels: set[int]) -> list[Scenario]:
    """Сначала сценарии других уровней, чем `levels`, порядок внутри сохраняется.

    HQ-032 (лист решений 18.10): пара ступени 4 — одна карточка уровня 1 и одна уровня 2.
    [ASSUMPTION] Другого уровня в пуле службы нет — пара из одного уровня: карточек
    важнее, чем уровни."""
    return sorted(candidates, key=lambda item: item.level in levels)


async def step_scenarios(request: Request, step: Step, service_id: str | None) -> list[Scenario]:
    """Сценарии тренировки ступени (`step_pool`), которых обучаемый ещё не проходил.

    Не хватает таких — сервер готовит новые по уровню ступени и слабому месту обучаемого
    (GP-14, `autogen.issue_generated`). Не получилось и это — повторяем пройденные.
    """
    db = request.state.db
    user = request.state.user
    pool = await step_pool(db, step, service_id)
    seen = set(
        await db.scalars(
            select(Assignment.scenario_id)
            .join(Session, Session.id == Assignment.session_id)
            .where(Session.teacher_id == user.id, Session.kind == "practice")
        )
    )
    fresh = [item for item in pool if item.id not in seen]
    random.shuffle(fresh)
    if len(fresh) < step.parallel and service_id is not None:
        weak = weak_spots(await recent_scores(db, user.id))
        for _ in range(step.parallel - len(fresh)):
            made = await issue_generated(
                db,
                service_id=service_id,
                level=random.choice(step.levels),
                focus=weak[0] if weak else None,
            )
            if made is not None:
                fresh.append(made)
    if not fresh:
        fresh = list(pool)
        random.shuffle(fresh)
    if not fresh:
        raise HTTPException(
            422,
            {
                "code": "practice_unavailable",
                "message": f"Для ступени {step.number} нет одобренных сценариев вашей службы. "
                "Попросите преподавателя добавить их в студии сценариев.",
                "details": {},
            },
        )
    first = fresh[0]
    # Смена — одной службы: служба участника берётся из первой карточки (обучаемый без
    # службы иначе получил бы вторую карточку чужой ДДС). Свежих на пару не хватает —
    # добираем из пула, и только потом повторяем: параллельной работе важнее число карточек.
    same = list(
        {
            item.id: item
            for item in [*fresh, *pool]
            if item.target_service_id == first.target_service_id
        }.values()
    )
    rest = [item for item in fresh if item in same and item.id != first.id]
    rest += [item for item in same if item not in rest and item.id != first.id]
    rest = other_levels_first(rest, {first.level})
    chosen = [first, *rest] if rest else [first]
    return [chosen[index % len(chosen)] for index in range(step.parallel)]


async def final_scenarios(request: Request, step: Step, service_id: str | None) -> list[Scenario]:
    """Финальная смена (HQ-033): проработанные сценарии каталога (с событиями и ветками,
    `catalog_trains`) уровней ступени одной службы, по возможности разных происшествий;
    сначала сложнее (уровень 2). Не хватает разных — добираем тем же происшествием, потом
    повторяем: финальной смене важнее число карточек."""
    db = request.state.db
    pool = await step_pool(db, step, service_id)
    plans = await latest_plans(db, pool)
    pool = [item for item in pool if catalog_trains(item, plans.get(item.id)) is not None]
    if not pool:
        raise HTTPException(
            422,
            {
                "code": "practice_unavailable",
                "message": f"Для ступени {step.number} нет проработанных сценариев вашей службы. "
                "Попросите преподавателя добавить их в студии сценариев.",
                "details": {},
            },
        )
    random.shuffle(pool)
    pool.sort(key=lambda item: -item.level)
    first = pool[0]
    same = [item for item in pool if item.target_service_id == first.target_service_id]

    def incident(item: Scenario) -> str:
        card = item.card if isinstance(item.card, dict) else {}
        return str(card.get("incident_class") or item.id)

    chosen: list[Scenario] = []
    for item in same:
        if incident(item) not in {incident(other) for other in chosen}:
            chosen.append(item)
    chosen += [item for item in same if item not in chosen]
    return [chosen[index % len(chosen)] for index in range(step.parallel)]


@cache
def file_titles() -> dict[UUID, str]:
    """Названия сценариев из файлов `data/scenarios`: в базе у сценария названия нет.

    Читаются один раз за процесс; id — как у seed (`scenario_uuid`). Нечитаемый файл
    пропускается — его и seed не загрузит."""
    from app.seed.scenarios import scenario_uuid

    titles: dict[UUID, str] = {}
    for path in sorted((ROOT / "data" / "scenarios").glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            titles[scenario_uuid(data)] = str(data["title"])
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return titles


def catalog_trains(scenario: Scenario, plan: dict[str, Any] | None) -> list[str] | None:
    """Чему учит сценарий каталога — виды его событий в порядке плана, без повторов.

    None — сценария в каталоге нет: не одобрен, не годится для тренировки без
    преподавателя (`practice_candidate`), нет событий с ветками (линейный сценарий) или
    бригада не докладывает до завершающего статуса.

    Звонок заявителю каталогу не мешает: абонента «Заявитель» тренировка добавляет в телефон
    сама (`practice_phone_contacts`). В случайную выдачу ступеней такой сценарий всё равно не
    попадает (`step_pool`)."""
    if plan is None or scenario.status != "approved" or not practice_candidate(scenario):
        return None
    events = plan.get("events") or []
    messages = list(plan.get("messages") or [])
    if not events or not messages or missing_reports(scenario, messages):
        return None
    return list(dict.fromkeys(str(event["kind"]) for event in events))


async def latest_plans(db: AsyncSession, scenarios: list[Scenario]) -> dict[UUID, dict[str, Any]]:
    """План текущей версии каждого сценария одним запросом — по правилу `plan_messages`:
    последняя версия плана, не новее версии сценария."""
    versions = {item.id: item.version for item in scenarios}
    rows = await db.execute(
        select(
            ScenarioTrainingPlan.scenario_id,
            ScenarioTrainingPlan.scenario_version,
            ScenarioTrainingPlan.plan,
        )
        .where(ScenarioTrainingPlan.scenario_id.in_(versions))
        .order_by(ScenarioTrainingPlan.scenario_id, ScenarioTrainingPlan.scenario_version)
    )
    plans: dict[UUID, dict[str, Any]] = {}
    for scenario_id, version, plan in rows.tuples():
        if version <= versions[scenario_id]:
            plans[scenario_id] = plan
    return plans


def short_description(scenario: Scenario) -> str:
    """Что случилось — описание карточки (его обучаемый и так увидит); без него — первая
    фраза комментария преподавателя."""
    card = scenario.card if isinstance(scenario.card, dict) else {}
    text = str(card.get("description") or "").strip()
    if text:
        return text
    return re.split(r"(?<=[.!?])\s+", scenario.teacher_comment.strip(), maxsplit=1)[0]


async def practice_catalog(request: Request) -> list[schemas.PracticeScenario]:
    """Общий каталог обучаемого и преподавателя: по службе, уровню и названию."""
    db = request.state.db
    scenarios = list(
        await db.scalars(
            select(Scenario)
            .where(Scenario.status == "approved", Scenario.deleted_at.is_(None))
            .order_by(Scenario.id)
        )
    )
    plans = await latest_plans(db, scenarios)
    names = {
        service_id: name
        for service_id, name in (await db.execute(select(Service.id, Service.name))).tuples()
    }
    titles = file_titles()
    items: list[schemas.PracticeScenario] = []
    for scenario in scenarios:
        trains = catalog_trains(scenario, plans.get(scenario.id))
        if trains is None:
            continue
        card = scenario.card if isinstance(scenario.card, dict) else {}
        items.append(
            schemas.PracticeScenario(
                id=scenario.id,
                version=scenario.version,
                title=titles.get(scenario.id) or str(card.get("incident_class") or "Сценарий"),
                service_id=scenario.target_service_id,
                service_name=names.get(scenario.target_service_id, scenario.target_service_id),
                level=scenario.level,
                description=short_description(scenario),
                trains=trains,
            )
        )
    items.sort(key=lambda item: (item.service_id, item.level, item.title, str(item.id)))
    return items


async def catalog_scenario(db: AsyncSession, scenario_id: UUID) -> Scenario:
    """Сценарий из каталога для тренировки; не из каталога — понятная ошибка."""
    scenario = await db.get(Scenario, scenario_id)
    if scenario is None or scenario.deleted_at is not None:
        raise HTTPException(
            404,
            {
                "code": "scenario_not_found",
                "message": "Сценарий не найден. Обновите каталог сценариев.",
                "details": {},
            },
        )
    plans = await latest_plans(db, [scenario])
    if catalog_trains(scenario, plans.get(scenario.id)) is None:
        raise HTTPException(
            409,
            {
                "code": "scenario_not_in_catalog",
                "message": "Этого сценария нет в каталоге тренировок: его проходят только "
                "на занятии с преподавателем.",
                "details": {},
            },
        )
    return scenario


def practice_title(step: Step | None, chosen: Scenario | None) -> str:
    """Заголовок тренировки. «Тренировка: ступень N — …» разбор читает как номер ступени
    («Повторить ступень»), поэтому у сценария каталога заголовок другой."""
    if chosen is not None:
        card = chosen.card if isinstance(chosen.card, dict) else {}
        name = file_titles().get(chosen.id) or str(card.get("incident_class") or "")
        return f"Тренировка по каталогу: {name}" if name else "Тренировка по каталогу"
    if step is None:
        return PRACTICE_TITLE
    return f"Тренировка: ступень {step.number} — {step.title}"


def participant_level(step: Step | None, chosen: Scenario | None) -> int:
    if chosen is not None:
        return chosen.level
    if step is None or step.tutorial:
        return 1
    if step.parallel > 1:
        # Уровень участника задаёт нагрузку смены — фоновые карточки (`background.py`),
        # рекомендацию уровня и отчёт; ступень 4 нагружена, как до HQ-032 (уровни 3–4).
        # Ёмкость — отдельно: одновременных карточек не больше `parallel_cards` занятия.
        return PARALLEL_LEVEL
    return max(step.levels)


async def again_scenario(db: AsyncSession, user_id: UUID, card_id: UUID) -> Scenario:
    """Сценарий своей карточки — для «Пройти тренировку ещё раз» в разборе (проверка 17.10:
    кнопка открывала случайную карточку ступени вместо той же)."""
    found = await db.scalar(
        select(Scenario)
        .join(Assignment, Assignment.scenario_id == Scenario.id)
        .join(Card, Card.assignment_id == Assignment.id)
        .join(Participant, Participant.id == Assignment.participant_id)
        .where(Card.id == card_id, Participant.user_id == user_id)
    )
    if found is None:
        raise HTTPException(
            404,
            {"code": "card_not_found", "message": "Карточка не найдена.", "details": {}},
        )
    return found


async def start_practice(
    request: Request,
    step_number: int | None = None,
    scenario_id: UUID | None = None,
    catalog_scenario_id: UUID | None = None,
    again_card: UUID | None = None,
    demo: Literal["watch", "expert"] | None = None,
) -> schemas.Session:
    db = request.state.db
    user = request.state.user
    request.state.entity = "session"
    if again_card is not None and (scenario_id is not None or catalog_scenario_id is not None):
        raise HTTPException(
            422,
            {
                "code": "validation_error",
                "message": "Укажите карточку для повтора отдельно от сценария.",
                "details": {},
            },
        )
    again = await again_scenario(db, user.id, again_card) if again_card is not None else None
    if catalog_scenario_id is not None and (step_number is not None or scenario_id is not None):
        raise HTTPException(
            422,
            {
                "code": "validation_error",
                "message": "Укажите сценарий из каталога отдельно от ступени или повтора.",
                "details": {},
            },
        )
    chosen = (
        await catalog_scenario(db, catalog_scenario_id) if catalog_scenario_id is not None else None
    )
    if again is not None and step_number is None:
        from app.api.progress.service import is_tutorial

        # Tutorial намеренно исключён из каталога; повтор сохраняет обучающий путь.
        if not is_tutorial(again):
            chosen = await catalog_scenario(db, again.id)
    step = None
    repeat: Scenario | None = None
    if step_number is not None and not 1 <= step_number <= len(STEPS):
        raise HTTPException(422, f"Ступени — с 1 по {len(STEPS)}.")
    if scenario_id is not None:
        from app.api.progress.repeats import repeat_scenario
        from app.api.progress.service import trainee_attempts

        progress = step_progress(await trainee_attempts(db, user.id))
        repeat, step = await repeat_scenario(db, user.id, scenario_id, progress)
        if step_number is not None and step_number != step.number:
            raise HTTPException(422, f"Повтор этого сценария — на ступени {step.number}.")
    elif step_number is not None:
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
    if chosen is not None:
        scenarios = [chosen]
    elif repeat is not None and step is not None:
        scenarios = [repeat]
        if step.parallel > 1:
            others = await step_scenarios(request, step, user.dds_service_id)
            scenarios += others[: step.parallel - 1]
    elif step is None or step.tutorial:
        # Повтор — актуальное упражнение службы исходной карточки, даже если профиль
        # обучаемого с тех пор переведён в другую ДДС.
        service_id = again.target_service_id if again is not None else user.dds_service_id
        scenarios = [await tutorial_scenario(request, service_id)]
    elif again is not None:
        # Повтор карточки на её ступени: тот же сценарий; при параллельной работе вторая
        # карточка — из пула ступени той же службы, что повторяемая (у обучаемого без службы
        # пул иначе всех служб).
        pick = final_scenarios if step.final else step_scenarios
        rest = await pick(request, step, again.target_service_id) if step.parallel > 1 else []
        rest = [item for item in rest if item.id != again.id]
        if not step.final:
            rest = other_levels_first(rest, {again.level})
        scenarios = [again, *rest][: step.parallel]
        scenarios += [again] * (step.parallel - len(scenarios))
    elif step.final:
        scenarios = await final_scenarios(request, step, user.dds_service_id)
    else:
        scenarios = await step_scenarios(request, step, user.dds_service_id)
    scenario = scenarios[0]
    # Практика — учебный режим: подсказки орфографии включены всегда.
    # Подсказчик — только в упражнении; на ступенях 2–4 и в сценарии каталога обучаемый
    # работает сам.
    guided = chosen is None and (step is None or step.tutorial)
    settings = {
        **with_comment_defaults(settings_row.value),
        "hints_level": 1 if guided else 0,
        "spelling_hints": True,
        "parallel_cards": step.parallel if step else 1,
        # Финальная смена (HQ-033): вызов бригады подписан только бригадой.
        "final_shift": bool(step and step.final),
        # Показ (HQ-034): карточку ведёт курсор — она не попытка обучаемого. Вид показа
        # хранит сервер (HQ-035): перехватить можно только «Смотрю».
        "demo": demo is not None,
        "demo_mode": demo,
    }
    # Заявитель в телефоне ДДС — там, где без звонка ему сценарий не пройти (HQ-019).
    contacts = practice_phone_contacts(settings, scenarios)
    if contacts:
        settings["phone_contacts"] = {**(settings.get("phone_contacts") or {}), **contacts}
    # Автодобавление может не найти свободного номера. Проверяем итоговый телефон всех
    # карточек до остановки прежней попытки — одинаково для каталога, ступеней и повторов.
    for item in scenarios:
        call = (item.reference or {}).get("expected_call") or {}
        role = call.get("contact_role")
        if call.get("required") is True and isinstance(role, str):
            available = phone_contacts(settings, item.target_service_id)
            if not any(contact.get("role") == role for contact in available):
                raise step_conflict(
                    "practice_unavailable",
                    "Обязательный абонент недоступен в телефоне ДДС. "
                    "Попросите преподавателя проверить настройки абонентов.",
                )
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
    lesson = Session(
        teacher_id=user.id,
        title=practice_title(step, chosen),
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
        # Уровень участника ограничивает одновременные карточки (`participant_level`).
        level=participant_level(step, chosen),
        rating_at_start=rating.theta if rating else 0.0,
    )
    db.add(participant)
    await db.flush()
    gap = FINAL_GAP if step is not None and step.final else PARALLEL_GAP
    for order, item in enumerate(scenarios, start=1):
        at = now + gap * (order - 1)
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


async def take_over_practice(request: Request, session_id: UUID) -> schemas.Session:
    """Перехват показа «Смотрю» (HQ-035, лист решений 18.10): обучаемый нажал «Беру
    управление» и дальше ведёт карточку сам — это попытка «Вместе». Снимает признак показа
    (`settings.demo`): карточки тренировки идут в ступень обучения (упражнение — ступень 1)
    и в «Мои результаты». Тренировка без показа и повторный вызов — без изменений.

    Засчитывается только карточка, которую довёл сам обучаемый: перехват показа опытного
    (или показа без вида) и показа, где курсор уже закрыл карточку, — 409."""
    db = request.state.db
    user = request.state.user
    request.state.entity = "session"
    lesson = await db.scalar(
        select(Session)
        .where(Session.id == session_id, Session.teacher_id == user.id, Session.kind == "practice")
        .with_for_update()
    )
    if lesson is None:
        raise HTTPException(
            404,
            {"code": "session_not_found", "message": "Тренировка не найдена.", "details": {}},
        )
    if lesson.status != "running":
        raise HTTPException(
            409,
            {
                "code": "session_not_running",
                "message": "Тренировка уже закрыта — перехватывать нечего.",
                "details": {},
            },
        )
    settings = dict(lesson.settings_snapshot or {})
    if settings.get("demo"):
        if settings.get("demo_mode") != "watch":
            raise step_conflict(
                "demo_not_watch",
                "Перехватить можно только показ «Смотрю». Показ опытного досматривают до конца.",
            )
        closed = await db.scalar(
            select(Card.id)
            .join(Assignment, Assignment.id == Card.assignment_id)
            .where(Assignment.session_id == lesson.id, Card.closed_at.is_not(None))
            .limit(1)
        )
        if closed is not None:
            raise step_conflict(
                "demo_card_closed",
                "Карточку показа уже закрыл курсор — перехватывать нечего. "
                "Пройдите её сами в режиме «Вместе».",
            )
        request.state.audit_before = {"settings_snapshot": {"demo": True}}
        lesson.settings_snapshot = {**settings, "demo": False}
        await db.flush()
    await db.refresh(lesson, attribute_names=["participants"])
    result = serialize(lesson)
    request.state.entity_id = str(lesson.id)
    request.state.audit_after = result.model_dump(mode="json")
    return result
