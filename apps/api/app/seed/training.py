"""Синтетический справочник и учебные сценарии C-04: текстовый и с озвученными докладами."""

import asyncio
import copy
import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.sessions.practice import audio_scenario_id
from app.api.training.content import store_plan
from app.api.training.plan_check import (
    MAX_REPORT_PAUSE_S,
    missing_reports,
    plan_messages,
    report_pauses,
)
from app.core.config import settings
from app.core.db import Database
from app.core.models import Brigade, CallTarget, Scenario, Service, User
from app.seed.link112 import seed_link112
from app.seed.practice import audio_ref, load_audio
from app.seed.scenarios import seed_scenarios

logger = logging.getLogger(__name__)


# Четыре учебные бригады на службу: две доступны всегда, третья и четвёртая — когда у
# обучаемого в занятии четыре и шесть происшествий (app.api.training.brigades).
BRIGADES_PER_SERVICE = 4
# Категория Системы-112 в справочнике (contracts/data_formats.md).
SYSTEM_112_CATEGORY = "system112"


def brigade_ext(index: int, ordinal: int) -> str:
    """Прямой номер бригады: первые две — 201…212, как раньше, третья и четвёртая — 301…312."""
    base = 201 if ordinal < 2 else 301
    return str(base + index * 2 + ordinal % 2)


def copied_reference(source: Scenario) -> dict[str, Any]:
    """Эталон сценария-основы без обязательного звонка: звонок своей службе не нужен,
    обязательные звонки задают события сценария (GP-04)."""
    reference = copy.deepcopy(source.reference)
    reference["expected_call"] = {**reference["expected_call"], "required": False}
    return reference


def service_tag(service: Service) -> str:
    """Как службу называют в именах учебных записей: цифровая ДДС — своим номером («101»),
    остальные — названием («ЖКХ»). Идентификатор латиницей (`GKH`) на экран не выносим:
    интерфейс русский (`CONTRIBUTING.md`); то же правило в окне АРМ (`shared/services.ts`)."""
    return service.id if service.id.isdigit() else service.name


async def seed_catalog(db: AsyncSession) -> None:
    """Стабильные UUID; повтор сохраняет имена и активность существующих записей."""
    services = list(await db.scalars(select(Service).order_by(Service.id)))
    # Система-112 — адресат звонка, а не служба ДДС: бригад у неё нет. Номера бригад
    # считаются по службам ДДС, поэтому у прежних служб они не сдвигаются.
    dds = [service for service in services if service.category != SYSTEM_112_CATEGORY]
    for index, service in enumerate(dds):
        for ordinal in range(BRIGADES_PER_SERVICE):
            brigade_id = uuid5(NAMESPACE_URL, f"arm112:c04:{service.id}:brigade:{ordinal}")
            ext = brigade_ext(index, ordinal)
            await db.execute(
                insert(Brigade)
                .values(
                    id=brigade_id,
                    service_id=service.id,
                    name=f"Бригада {ext}",
                    is_active=True,
                )
                .on_conflict_do_nothing()
            )
            await db.execute(
                insert(CallTarget)
                .values(
                    id=uuid5(NAMESPACE_URL, f"arm112:c04:{service.id}:target:{ordinal}"),
                    service_id=service.id,
                    brigade_id=brigade_id,
                    name=f"Старший бригады {ext}",
                    phone_ext=ext,
                    voice_profile=service.voice_profile,
                    is_active=True,
                )
                .on_conflict_do_nothing()
            )
    for service in services:
        await db.execute(
            insert(CallTarget)
            .values(
                id=uuid5(NAMESPACE_URL, f"arm112:c04:{service.id}:dispatcher"),
                service_id=service.id,
                brigade_id=None,
                name=f"Учебный диспетчер {service_tag(service)}",
                phone_ext=service.phone_ext,
                voice_profile=service.voice_profile,
                is_active=True,
            )
            .on_conflict_do_nothing()
        )


async def seed_demo(db: AsyncSession) -> Scenario:
    """Существующие сценарии не расширяются планом: у примера собственный UUID."""
    await seed_catalog(db)
    teacher = await db.scalar(select(User).where(User.login == "teacher"))
    source = await db.scalar(
        select(Scenario)
        .where(Scenario.status == "approved", Scenario.target_service_id == "102")
        .order_by(Scenario.id)
        .limit(1)
    )
    if teacher is None or source is None:
        raise RuntimeError("Сначала выполните основной seed: нужны teacher и сценарий службы 102.")
    scenario_id = uuid5(NAMESPACE_URL, "arm112:c04:text-demo")
    existing = await db.get(Scenario, scenario_id)
    if existing is not None:
        return existing
    scenario = Scenario(
        id=scenario_id,
        version=1,
        level=1,
        weight=source.weight,
        incident_type_code=source.incident_type_code,
        target_service_id="102",
        card={**copy.deepcopy(source.card), "number": "70004001"},
        reference=copied_reference(source),
        complications=[],
        origin="template",
        status="approved",
        author_id=teacher.id,
        teacher_comment="Синтетический пример C-04: текстовые сведения, без записи голоса.",
    )
    db.add(scenario)
    await db.flush()
    brigade_id = uuid5(NAMESPACE_URL, "arm112:c04:102:brigade:0")
    target_id = uuid5(NAMESPACE_URL, "arm112:c04:102:target:0")
    messages = []
    for index, value in enumerate(
        ["Бригада прибыла к месту происшествия.", "Учебные работы завершены, угрозы устранены."]
    ):
        messages.append(
            {
                "message": {
                    "id": str(uuid5(scenario_id, f"message:{index}")),
                    "version": 1,
                    "text": value,
                    "audio": None,
                },
                "brigade_id": str(brigade_id),
                "call_target_id": str(target_id),
                "available_after_s": index * 2,
                "expected_comment": value,
            }
        )
    await store_plan(
        db,
        scenario.id,
        scenario.version,
        teacher.id,
        {
            "version": 1,
            "required_brigade_ids": [str(brigade_id)],
            "messages": messages,
            "observable_defects": [],
        },
    )
    return scenario


# Бригада докладывает по ходу разговора: выезд, прибытие, работы, завершение (памятка ДДС).
# Этапы "completion"/"complication" пока живут отдельными манифестами
# (data/voices/brigade/*.pending.json): gates.sh запрещает менять уже закоммиченный
# manifest.json, поэтому все файлы читаются и объединяются здесь, в памяти, а не на диске.
AUDIO_STAGE_AFTER_S = {
    "departure": 3,
    "arrival": 10,
    "works": 18,
    "completion": 26,
    "complication": 22,
}

# v1: три доклада, без "работы завершены" — выведен в архив 28.09 (AUDIO_GENERATIONS).
AUDIO_DEMO_STAGES_V1 = ("departure", "arrival", "works")
# v2: доклад о завершении работ добавляет статусы "arrived"/"working" в ожидаемый ход дела —
# без него обучаемый, честно поставивший эти статусы, терял баллы (находка 26.09).
AUDIO_DEMO_STAGES_V2 = ("departure", "arrival", "works", "completion")
AUDIO_DEMO_V2_EXPECTED_FLOW = [
    "received",
    "accepted",
    "responding",
    "arrived",
    "working",
    "completed",
]
# v3 (VAR-01): после доклада о работах — доклад-осложнение, требующий действия
# (отказ от выполнения работ), а не перефразировки прежнего доклада; "refused" —
# терминальный статус (памятка ДДС), поэтому доклада о завершении здесь нет.
AUDIO_DEMO_STAGES_V3 = ("departure", "arrival", "works", "complication")
AUDIO_DEMO_V3_EXPECTED_FLOW = [
    "received",
    "accepted",
    "responding",
    "arrived",
    "working",
    "refused",
]
# Доклад-осложнение обосновывает статус "Отказ от выполнения работ"
# (L-01, PlannedMessage.justifies_state).
AUDIO_DEMO_V3_JUSTIFIES_STATE = {"complication": "refused"}

# Обучающее упражнение (тренировка обучаемого, startPractice): полный цикл v2, но бригада
# докладывает только после решения диспетчера — requires_state. Пауза после статуса
# короткая: учим порядку действий, а не ожиданию.
TUTORIAL_STAGES = AUDIO_DEMO_STAGES_V2
TUTORIAL_REQUIRES_STATE = {
    "departure": "accepted",
    "arrival": "responding",
    "works": "arrived",
    "completion": "working",
}
TUTORIAL_AFTER_S = {"departure": 3, "arrival": 4, "works": 4, "completion": 4}
# Ключ задаёт id сценария: startPractice ищет упражнение по tutorial_scenario_id.
TUTORIAL_KEY = "tutorial"

# Параллельная смена (27.09, Q11): бригада в пути и на работах — время, в которое
# диспетчер берёт новые карточки. Отсчёт — от отправки или нужного статуса; готовый
# доклад бригада передаёт сама, позвонив диспетчеру. Секунды сжаты под занятие; пауза —
# не больше 40 с (эталон, 1.5).
PARALLEL_KEY = "parallel"
PARALLEL_AFTER_S = {"departure": 3, "arrival": 40, "works": 40, "completion": 40}


def _load_audio_manifest(audio_dir: Path) -> dict[str, list[dict]]:
    """Доклады по этапам: тексты — манифесты data/voices/brigade, запись — банк озвучки.

    С 17.10 доклады учебных сценариев звучат записями банка (ElevenLabs, наборы bank-v*):
    у текста нет записи — `path` пуст, доклад уходит текстом.
    """
    bank = {
        (item["service_id"], item["text"]): item
        for manifest in sorted(audio_dir.glob("bank-v*/manifest.json"))
        for item in json.loads(manifest.read_text(encoding="utf-8"))["messages"]
    }
    by_service: dict[str, list[dict]] = {}
    for name in ("manifest.json", "completion.pending.json", "complication.pending.json"):
        path = audio_dir / "brigade" / name
        if not path.exists():
            continue
        manifest = json.loads(path.read_text(encoding="utf-8"))
        for item in manifest["messages"]:
            recorded = bank.get((item["service_id"], item["text"]))
            by_service.setdefault(item["service_id"], []).append(
                {
                    "stage": item["stage"],
                    "text": item["text"],
                    "path": recorded["path"] if recorded else None,
                }
            )
    return by_service


async def _seed_audio_scenarios(
    db: AsyncSession,
    teacher: User,
    by_service: dict[str, list[dict]],
    audio_dir: Path,
    *,
    scenario_key: str,
    stages: tuple[str, ...],
    card_number_prefix: str,
    expected_flow: list[str] | None,
    level: int = 1,
    justifies_state_by_stage: dict[str, str] | None = None,
    requires_state_by_stage: dict[str, str] | None = None,
    after_s_by_stage: dict[str, int] | None = None,
    comment: str | None = None,
    retired: bool = False,
) -> list[Scenario]:
    created: list[Scenario] = []
    for index, service_id in enumerate(sorted(by_service)):
        items_by_stage = {item["stage"]: item for item in by_service[service_id]}
        if not all(stage in items_by_stage for stage in stages):
            continue
        scenario_id = audio_scenario_id(scenario_key, service_id)
        # Прежнее поколение с записями Piper — в архив, выданные планы не меняются.
        piper = await db.get(Scenario, audio_scenario_id(scenario_key, service_id, None))
        if piper is not None:
            retire([piper])
        if retired:
            continue
        existing = await db.get(Scenario, scenario_id)
        if existing is not None:
            # Упражнения обслуживаются seed и не зависят от архива студии.
            if scenario_key == TUTORIAL_KEY and (
                existing.status != "approved" or existing.deleted_at is not None
            ):
                existing.status = "approved"
                existing.deleted_at = None
                existing.version += 1
            created.append(existing)
            continue
        source = await db.scalar(
            select(Scenario)
            .where(Scenario.status == "approved", Scenario.target_service_id == service_id)
            .order_by(Scenario.id)
            .limit(1)
        )
        if source is None:
            continue
        brigade_id = uuid5(NAMESPACE_URL, f"arm112:c04:{service_id}:brigade:0")
        target_id = uuid5(NAMESPACE_URL, f"arm112:c04:{service_id}:target:0")
        reference = copied_reference(source)
        if expected_flow is not None:
            reference["expected_flow"] = list(expected_flow)
        scenario = Scenario(
            id=scenario_id,
            version=1,
            level=level,
            weight=source.weight,
            incident_type_code=source.incident_type_code,
            target_service_id=service_id,
            card={**copy.deepcopy(source.card), "number": f"{card_number_prefix}{index}"},
            reference=reference,
            complications=[],
            origin="template",
            status="approved",
            author_id=teacher.id,
            teacher_comment=comment
            or (
                "Учебный пример C-04: доклады бригады о выезде, прибытии, работах"
                + (" и завершении" if "completion" in stages else "")
                + (" с осложнением: отказ от выполнения работ" if "complication" in stages else "")
                + " озвучены голосами банка; позвоните первой бригаде по её прямому номеру."
            ),
        )
        db.add(scenario)
        await db.flush()
        messages = []
        for stage in stages:
            item = items_by_stage[stage]
            audio = None
            if item["path"]:
                root = item["path"].split("/", 1)[0]
                manifest = load_audio(audio_dir, Path(root) / "manifest.json")
                audio = await audio_ref(db, audio_dir, manifest, item["path"], item["text"])
            planned: dict[str, object] = {
                "message": {
                    "id": str(uuid5(scenario_id, f"message:{stage}")),
                    "version": 1,
                    "text": item["text"],
                    "audio": audio,
                },
                "brigade_id": str(brigade_id),
                "call_target_id": str(target_id),
                "available_after_s": (after_s_by_stage or AUDIO_STAGE_AFTER_S)[stage],
                "expected_comment": item["text"],
            }
            if justifies_state_by_stage and stage in justifies_state_by_stage:
                planned["justifies_state"] = justifies_state_by_stage[stage]
            if requires_state_by_stage and stage in requires_state_by_stage:
                planned["requires_state"] = requires_state_by_stage[stage]
            messages.append(planned)
        await store_plan(
            db,
            scenario.id,
            scenario.version,
            teacher.id,
            {
                "version": 1,
                "required_brigade_ids": [str(brigade_id)],
                "messages": messages,
                "observable_defects": [],
            },
        )
        created.append(scenario)
    return created


@dataclass(frozen=True)
class AudioGeneration:
    """Поколение учебных сценариев с озвученными докладами: по сценарию на службу."""

    key: str
    stages: tuple[str, ...]
    card_number_prefix: str
    expected_flow: list[str] | None
    level: int = 1
    justifies_state_by_stage: dict[str, str] | None = None
    requires_state_by_stage: dict[str, str] | None = None
    after_s_by_stage: dict[str, int] | None = None
    comment: str | None = None
    # Выведено из раздачи: эталон ждёт статус, о котором бригада не докладывает.
    retired: bool = False


# Какой статус карточки обосновывает доклад этапа (памятка ДДС, стр. 22: статусы хода
# работ ставятся по факту полученной информации).
STAGE_JUSTIFIES = {
    "departure": "responding",
    "arrival": "arrived",
    "works": "working",
    "completion": "completed",
    "complication": "refused",
}

AUDIO_GENERATIONS: tuple[AudioGeneration, ...] = (
    # Первое поколение: доклада о завершении нет, а эталон (от основы) ждёт «Работы
    # завершены» — обучаемый закрывал карточку без сведений (замечание капитана 28.09).
    # Выведено в архив; выданные планы не трогаем.
    AudioGeneration(
        key="audio-demo",
        stages=AUDIO_DEMO_STAGES_V1,
        card_number_prefix="7000420",
        expected_flow=None,
        retired=True,
    ),
    AudioGeneration(
        key="audio-demo-v2",
        stages=AUDIO_DEMO_STAGES_V2,
        card_number_prefix="7000421",
        expected_flow=AUDIO_DEMO_V2_EXPECTED_FLOW,
    ),
    AudioGeneration(
        key="audio-demo-v3",
        stages=AUDIO_DEMO_STAGES_V3,
        card_number_prefix="7000422",
        expected_flow=AUDIO_DEMO_V3_EXPECTED_FLOW,
        level=3,
        justifies_state_by_stage=AUDIO_DEMO_V3_JUSTIFIES_STATE,
    ),
    AudioGeneration(
        key=TUTORIAL_KEY,
        stages=TUTORIAL_STAGES,
        card_number_prefix="7000423",
        expected_flow=AUDIO_DEMO_V2_EXPECTED_FLOW,
        requires_state_by_stage=TUTORIAL_REQUIRES_STATE,
        after_s_by_stage=TUTORIAL_AFTER_S,
        comment=(
            "Обучающее упражнение: полный цикл карточки. Бригада докладывает о выезде, "
            "прибытии, работах и завершении только после того, как диспетчер отметит "
            "предыдущий шаг статусом в карточке."
        ),
    ),
    AudioGeneration(
        key=PARALLEL_KEY,
        stages=TUTORIAL_STAGES,
        card_number_prefix="7000424",
        expected_flow=AUDIO_DEMO_V2_EXPECTED_FLOW,
        level=2,
        requires_state_by_stage=TUTORIAL_REQUIRES_STATE,
        after_s_by_stage=PARALLEL_AFTER_S,
        comment=(
            "Параллельная смена: бригада едет к месту и работает по 40 секунд — "
            "в это время приходят другие карточки. Прибыв и закончив, бригада "
            "звонит сама. Раздавайте по две-три таких карточки с задержкой 0 / 45 / 90 с "
            "в занятии с «Карточек одновременно: 2»."
        ),
    ),
)


def uncovered_states(generation: AudioGeneration) -> list[str]:
    """Статусы хода работ из эталона, о которых бригада этого поколения не докладывает."""
    reported = {STAGE_JUSTIFIES[stage] for stage in generation.stages}
    flow = generation.expected_flow or []
    after_decision = flow[flow.index("accepted") + 1 :] if "accepted" in flow else flow
    return [state for state in after_decision if state not in reported]


def retire(scenarios: list[Scenario]) -> None:
    """Сценарий уходит в архив, содержимое и выданные планы не меняются.

    Версию, в отличие от retireScenario, не поднимаем: назначения, созданные до 28.09,
    версию не хранят и читают план по текущей версии сценария — уже выданные карточки
    остались бы без докладов.
    """
    for scenario in scenarios:
        if scenario.status == "approved":
            scenario.status = "retired"


async def seed_audio_demo(db: AsyncSession, audio_dir: Path) -> list[Scenario]:
    """По сценарию на службу с озвученными докладами первой учебной бригады.

    Аудио — неизменяемые файлы `data/voices/brigade` (манифест с SHA-256): версия
    регистрируется один раз, повторный запуск ничего не меняет. Службы без
    утверждённого сценария-основы пропускаются, их карточки не выдумываются.

    Поколения — `AUDIO_GENERATIONS`: старое `audio-demo` (три доклада, выведено в архив),
    `audio-demo-v2` (с докладом о завершении), `audio-demo-v3` (уровень 3: доклад-
    осложнение, отказ от выполнения работ), `tutorial` — обучающее упражнение, где каждый
    доклад ждёт статуса диспетчера (`requires_state`), и `parallel` — смена с
    параллельными карточками: бригада в пути и на работах минуту и звонит сама.
    """
    await seed_catalog(db)
    teacher = await db.scalar(select(User).where(User.login == "teacher"))
    if teacher is None:
        raise RuntimeError("Сначала выполните основной seed: нужен преподаватель teacher.")
    by_service = _load_audio_manifest(audio_dir)
    created: list[Scenario] = []
    for generation in AUDIO_GENERATIONS:
        scenarios = await _seed_audio_scenarios(
            db,
            teacher,
            by_service,
            audio_dir,
            scenario_key=generation.key,
            stages=generation.stages,
            card_number_prefix=generation.card_number_prefix,
            expected_flow=generation.expected_flow,
            level=generation.level,
            justifies_state_by_stage=generation.justifies_state_by_stage,
            requires_state_by_stage=generation.requires_state_by_stage,
            after_s_by_stage=generation.after_s_by_stage,
            comment=generation.comment,
            retired=generation.retired,
        )
        created += scenarios
    await db.flush()
    return created


@dataclass(frozen=True)
class CatalogCheck:
    """Утверждённые сценарии, которые не годятся ДДС как есть (эталон, 1.5)."""

    # Нет докладов до завершающего статуса: в тренировку и подбор не идут.
    unclosable: list[Scenario]
    # Доклад плана ждут дольше MAX_REPORT_PAUSE_S.
    slow: list[Scenario]


async def check_catalog(db: AsyncSession) -> CatalogCheck:
    """Проверка каталога после загрузки: план полный и паузы между докладами короткие.

    Выданный план неизменяем: на развёрнутом стенде старые паузы остаются, пока сценарий
    не выпущен новой версией, — поэтому это предупреждение, а не отказ загрузки.
    """
    unclosable, slow = [], []
    rows = await db.scalars(
        select(Scenario).where(Scenario.status == "approved").order_by(Scenario.id)
    )
    for scenario in rows:
        messages = await plan_messages(db, scenario)
        if missing_reports(scenario, messages):
            unclosable.append(scenario)
        elif any(pause > MAX_REPORT_PAUSE_S for pause in report_pauses(messages)):
            slow.append(scenario)
    return CatalogCheck(unclosable, slow)


async def main() -> None:
    database = Database(settings.database_url)
    try:
        async with database.sessions.begin() as db:
            scenario = await seed_demo(db)
            scenario_id = scenario.id
            audio = await seed_audio_demo(db, settings.information_audio_dir)
            numbers = [item.card["number"] for item in audio if item.status == "approved"]
            # Каталог сценариев ДДС (data/scenarios): занятия и тренировка ступеней 2–3.
            practice = await seed_scenarios(db, settings.information_audio_dir)
            # Связка 112 → ДДС, шаг 1: карточки от оператора-бота для занятий преподавателя.
            link = await seed_link112(db, settings.information_audio_dir)
            catalog = await check_catalog(db)
        logger.info("Учебный пример C-04 готов: scenario_id=%s", scenario_id)
        logger.info("Сценарии с озвученными докладами бригад: %s", ", ".join(numbers) or "нет")
        logger.info("Сценарии ДДС из data/scenarios: %s", len(practice))
        logger.info(
            "Сценарии связки 112 → ДДС: %s",
            ", ".join(f"{item.card['number']} ({item.target_service_id})" for item in link)
            or "нет",
        )
        if catalog.unclosable:
            logger.warning(
                "Без докладов бригады до завершающего статуса — в тренировку и подбор не идут: %s",
                ", ".join(numbers_of(catalog.unclosable)),
            )
        if catalog.slow:
            logger.warning(
                "Доклад бригады ждать дольше %s с: %s",
                MAX_REPORT_PAUSE_S,
                ", ".join(numbers_of(catalog.slow)),
            )
    finally:
        await database.close()


def numbers_of(scenarios: list[Scenario]) -> list[str]:
    return [f"{item.card['number']} ({item.target_service_id})" for item in scenarios]


if __name__ == "__main__":
    from app.core.logging import configure_logging

    configure_logging()
    asyncio.run(main())
