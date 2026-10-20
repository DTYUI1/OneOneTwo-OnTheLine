"""Генерация и автодопуск только нового сценария в транзакции worker."""

import asyncio
import hashlib
import json
import logging
import time
from collections import Counter
from pathlib import Path
from typing import Any
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.training.content import store_plan
from app.core.config import ROOT, settings
from app.core.contracts import validate_json
from app.core.models import (
    Assignment,
    AuditLog,
    Brigade,
    CallTarget,
    Participant,
    Scenario,
    ScenarioTrainingPlan,
    Service,
    Session,
)
from app.worker.generators.history import HISTORY_LESSONS
from app.worker.generators.scenario import (
    build_scenario,
    chosen_phrases,
    fallback_response,
    generation_input,
    phrase_ids,
)
from app.worker.generators.validation import (
    PROMPT_VERSION,
    GenerationRejected,
    GenerationUnavailable,
    validate_response,
)
from app.worker.providers.interfaces import LLMProvider

GAMEPLAY_PROMPT_VERSION = "dds-gameplay-v3"
# Ветки, которые проходит сгенерированный сценарий: эталон и все ветки ловушки повтора адреса.
COHERENCE_POLICIES = ["эталон", "readback"]

logger = logging.getLogger(__name__)


async def coherence(db: AsyncSession, data: dict[str, Any]) -> list[dict[str, Any]] | None:
    """Нарушения связности сценария (только `failing`) или None — стенд прохода недоступен.

    Решение о черновике или каталожном fallback принимает вызывающий генератор."""
    from app.tools.coherence.check import StandError, check_scenario

    try:
        found = await asyncio.to_thread(
            check_scenario,
            data,
            database=db.get_bind().engine.url.render_as_string(hide_password=False),
            policies=COHERENCE_POLICIES,
            jobs=settings.generation_coherence_jobs,
            timeout=settings.generation_coherence_timeout_seconds,
        )
    except StandError as exc:
        logger.warning("Проход связности недоступен: %s", exc)
        return None
    failing = [dict(item) for item in found if item.get("failing")]
    # Движок упал во всех политиках (нет файла, сломано окружение) — это стенд, а не ответ
    # модели: вторая попытка не поможет.
    if failing and all(item["rule"] == "run_failed" for item in failing):
        logger.warning(
            "Проход связности упал на окружении, сценарий без него: %s", failing[0]["detail"]
        )
        return None
    return failing


async def generate_one(
    db: AsyncSession,
    llm: LLMProvider,
    *,
    scenario_id: UUID,
    author_id: UUID,
    service_id: str,
    level: int,
    seed: int,
    auto_admit: bool,
    weight: int | None = None,
    session_id: UUID | None = None,
    participant_id: UUID | None = None,
    selected_ids: tuple[UUID, ...] = (),
    categories: list[str] | tuple[str, ...] = (),
    weak_spots: dict[str, Any] | None = None,
    focus: bool | None = None,
    pairwise_batch: bool = False,
) -> Scenario:
    """Новый сценарий: на каркасе каталога формата 2, если для службы он есть, иначе из банка."""
    from app.worker.generators.gameplay import templates

    if any(template["service_id"] == service_id for template in templates()):
        return await generate_gameplay_one(
            db,
            llm,
            scenario_id=scenario_id,
            author_id=author_id,
            service_id=service_id,
            level=level,
            seed=seed,
            auto_admit=auto_admit,
            weight=weight,
            session_id=session_id,
            participant_id=participant_id,
            selected_ids=selected_ids,
            categories=categories,
            weak_spots=weak_spots,
            focus=focus,
            pairwise_batch=pairwise_batch,
        )
    return await generate_bank_one(
        db,
        llm,
        scenario_id=scenario_id,
        author_id=author_id,
        service_id=service_id,
        level=level,
        seed=seed,
        auto_admit=auto_admit,
        weight=weight,
    )


async def gameplay_history(
    db: AsyncSession,
    *,
    author_id: UUID,
    session_id: UUID | None = None,
    participant_id: UUID | None = None,
    selected_ids: tuple[UUID, ...] = (),
    all_lessons: bool = False,
) -> list[Scenario]:
    """История автора либо назначения обучаемого за пять занятий и текущий выбор."""
    if session_id is None and participant_id is None:
        # Сценарии текущего пакета уже входят в историю автора: второй раз не добавляем.
        return list(
            await db.scalars(
                select(Scenario)
                .where(Scenario.author_id == author_id, Scenario.generation_metadata.is_not(None))
                .order_by(Scenario.created_at, Scenario.id)
            )
        )
    if participant_id is None:
        raise GenerationRejected("Для истории занятия нужен обучаемый.")
    lessons = (
        select(Session.id)
        .join(Participant, Participant.session_id == Session.id)
        .where(
            Participant.user_id == participant_id,
            Session.id != session_id if session_id else Session.id.is_not(None),
            Session.kind == "lesson",
            Session.started_at.is_not(None),
        )
        .order_by(Session.started_at.desc(), Session.id)
        .limit(None if all_lessons else HISTORY_LESSONS)
    )
    history = list(
        await db.scalars(
            select(Scenario)
            .join(Assignment, Assignment.scenario_id == Scenario.id)
            .join(Participant, Participant.id == Assignment.participant_id)
            .join(Session, Session.id == Assignment.session_id)
            .where(Participant.user_id == participant_id, Assignment.session_id.in_(lessons))
            .order_by(Session.started_at, Session.id, Assignment.order, Assignment.id)
        )
    )
    # Повторные назначения сохраняем как частоту. Персональный пакет не должен
    # возвращать назначения старше окна; добавляем лишь последние ещё не назначенные
    # сценарии. Полная история путей отдельно нужна для исчерпания разнообразия.
    personal_query = select(Scenario).where(
        Scenario.generation_metadata["constructor"]["personalization"]["user_id"].astext
        == str(participant_id)
    )
    if not all_lessons:
        assigned = (
            select(Assignment.id)
            .join(Participant, Participant.id == Assignment.participant_id)
            .where(Assignment.scenario_id == Scenario.id, Participant.user_id == participant_id)
            .exists()
        )
        personal_query = personal_query.where(~assigned).limit(HISTORY_LESSONS)
    personal = list(
        await db.scalars(personal_query.order_by(Scenario.created_at.desc(), Scenario.id.desc()))
    )
    current = {
        row.id: row
        for row in await db.scalars(select(Scenario).where(Scenario.id.in_(selected_ids)))
    }
    known = {row.id for row in history}
    for row in [*reversed(personal), *(current[sid] for sid in selected_ids if sid in current)]:
        if row.id not in known:
            history.append(row)
            known.add(row.id)
    return history


async def generate_gameplay_one(
    db: AsyncSession,
    llm: LLMProvider,
    *,
    scenario_id: UUID,
    author_id: UUID,
    service_id: str,
    level: int,
    seed: int,
    auto_admit: bool,
    weight: int | None = None,
    session_id: UUID | None = None,
    participant_id: UUID | None = None,
    selected_ids: tuple[UUID, ...] = (),
    categories: list[str] | tuple[str, ...] = (),
    correction: dict[str, Any] | None = None,
    weak_spots: dict[str, Any] | None = None,
    focus: bool | None = None,
    pairwise_batch: bool = False,
) -> Scenario:
    """Каркас шаблона (вариант B): две попытки модели, затем история шаблона, честно template."""
    from app.seed.practice import audio_ref, load_audio
    from app.seed.scenarios import scenario_row, training_plan
    from app.worker.generators import gameplay

    existing = await db.get(Scenario, scenario_id)
    if existing is not None:
        if existing.generation_metadata is None:
            raise GenerationRejected("Идентификатор занят сценарием другого происхождения.")
        return existing
    service = await db.get(Service, service_id)
    if service is None or not service.is_active:
        raise GenerationRejected("Нужна активная служба.")
    # Два пакета одного автора не должны одновременно выбрать один оставшийся путь.
    owner = participant_id or author_id
    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"generation-variants:{owner}:{service_id}:{level}"},
    )
    history = await gameplay_history(
        db,
        author_id=author_id,
        session_id=session_id,
        participant_id=participant_id,
        selected_ids=selected_ids,
    )
    from app.seed.scenarios import scenario_uuid, superseded

    catalog = {
        sid: t["code"] for t in gameplay.templates() for sid in [scenario_uuid(t), *superseded(t)]
    }
    usage: Counter[str] = Counter()
    used: dict[str, list[dict[str, str]]] = {}
    for previous in history:
        metadata = previous.generation_metadata or {}
        code = metadata.get("constructor", {}).get("template") or catalog.get(previous.id)
        if code:
            usage[code] += 1
            reports = metadata.get("phrases", {}).get("reports")
            if not metadata:
                # Старой версии каталога соответствует её сохранённый план, а не
                # текущие доклады файла с тем же кодом.
                saved_plan = await db.get(ScenarioTrainingPlan, (previous.id, previous.version))
                if saved_plan is not None:
                    phrases = {
                        p["text"]: p["id"]
                        for p in gameplay.bank(previous.target_service_id)["phrases"]
                    }
                    reports = {
                        message["justifies_state"]: phrases.get(message["message"]["text"])
                        for message in saved_plan.plan["messages"]
                    }
            if reports and (participant_id is not None or previous.id in selected_ids):
                used.setdefault(code, []).append(reports)
    from app.worker.generators import pairwise, variant_paths

    path_history = (
        history
        if participant_id is None
        else await gameplay_history(
            db,
            author_id=author_id,
            session_id=session_id,
            participant_id=participant_id,
            selected_ids=selected_ids,
            all_lessons=True,
        )
    )
    path_counts = variant_paths.usage(path_history, service_id, level)
    if participant_id is not None and weak_spots is None:
        from app.api.analysis.weak_spots import profile

        weak_spots = await profile(db, participant_id)
    focused = focus if focus is not None else seed % 5 < 3
    source, prepared = variant_paths.pick(
        service_id,
        level,
        seed,
        path_counts,
        usage,
        categories,
        batch_variations={
            code: [
                row.generation_metadata["constructor"]["variation"]
                for row in history
                if row.id in selected_ids
                and row.generation_metadata is not None
                and row.generation_metadata.get("constructor", {}).get("template") == code
                and row.generation_metadata["constructor"].get("variation")
            ]
            for code in usage
        },
        profile=weak_spots,
        focus=focused,
        covered_pairs=(
            pairwise.covered(row for row in history if row.id in selected_ids)
            if pairwise_batch
            else None
        ),
    )
    correction_spec = None
    if correction:
        correction_source = next(
            (
                t
                for t in gameplay.templates()
                if t["code"] == correction["metadata"]["constructor"]["template"]
            ),
            None,
        )
        if correction_source is None:
            raise GenerationRejected("Исходный каркас больше недоступен.")
        source = correction_source
        correction_spec = gameplay.correction_input(
            source, level, seed, correction["note"], correction["metadata"], weight
        )
        prepared = next(iter(correction_spec["variants"].values()))["template"]
    spec = gameplay.gameplay_input(
        service_id=service_id,
        level=level,
        seed=seed,
        weight=weight,
        template=source,
        prepared=prepared,
    )
    spec = gameplay.variety_input(spec, used.get(spec["template"]["code"], []))
    attempts: list[dict[str, Any]] = []
    accepted: dict[str, Any] | None = None
    coherence_info: dict[str, Any] = {"status": "unchecked", "reason": "Проход не запускался."}
    stand_unavailable = False
    catalog_fallback = False
    # Проход связности — только ответу модели: шаблонный путь каталог уже проверил.
    check = settings.generation_coherence and getattr(llm, "is_generative", False)
    for number in (1, 2):
        started = time.monotonic()
        prompt = json.dumps((correction_spec or spec)["facts"], ensure_ascii=False, sort_keys=True)
        response = await llm.complete_json(prompt)
        error = None
        diagnostics = dict(getattr(llm, "last_diagnostics", {}))
        retry = None
        try:
            if response is None:
                raise GenerationRejected("Провайдер недоступен или ответ отклонён.")
            if correction_spec:
                gameplay.validate_gameplay(correction_spec["facts"], response)
                spec = correction_spec["variants"][response["variant"]]
                response = {"choices": response["choices"]}
            gameplay.validate_gameplay(spec["facts"], response)
            gameplay.chosen_phrases(spec, response)
            # Сочетание фраз проверяет загрузчик каталога (схема, связность, линтер).
            data = gameplay.build_gameplay(
                spec, response, scenario_id=scenario_id, origin="llm", auto_admit=auto_admit
            )
            if check:
                violations = await coherence(db, data)
                diagnostics["coherence"] = (
                    {"checked": False}
                    if violations is None
                    else {"checked": True, "violations": violations[:10]}
                )
                if violations is None:
                    stand_unavailable = True
                    coherence_info = {
                        "status": "unchecked",
                        "reason": "Проход связности недоступен.",
                    }
                    if auto_admit:
                        raise GenerationRejected("Проход недоступен: нужен каталожный путь.")
                elif not violations:
                    coherence_info = {"status": "passed", "reason": "Проход выполнен."}
                if violations:
                    retry = gameplay.retry_input(spec, violations)
                    raise GenerationRejected(
                        "Проход связности: "
                        + "; ".join(f"{v['rule']} ({v['policy']})" for v in violations)[:300]
                    )
            accepted = response
        except GenerationRejected as exc:
            error = str(exc)
        attempts.append(
            {
                "number": number,
                "accepted": accepted is not None,
                "error": error,
                "duration_seconds": round(time.monotonic() - started, 3),
                "diagnostics": diagnostics,
            }
        )
        if accepted is not None or (stand_unavailable and auto_admit):
            break
        if correction_spec and error:
            correction_spec["facts"]["correction_error"] = error
        elif retry is not None:
            spec = retry
    if correction and (accepted is None or not getattr(llm, "is_generative", False)):
        if attempts[-1]["diagnostics"].get("retryable"):
            raise GenerationUnavailable(
                "Сервер ИИ не ответил. Исходный черновик сохранён. "
                "При повторном сбое попробуйте позже."
            )
        raise GenerationRejected("ИИ не смог обработать замечание; исходный черновик сохранён.")
    fallback = accepted is None or not getattr(llm, "is_generative", False)
    catalog_fallback = auto_admit and stand_unavailable
    if (
        not catalog_fallback
        and accepted is None
        and any(a["diagnostics"].get("coherence", {}).get("violations") for a in attempts)
    ):
        # Неудача связности может быть в триггерах, а не в выборе фраз модели.
        baseline = gameplay.gameplay_input(
            service_id=service_id,
            level=level,
            seed=seed,
            weight=weight,
            template=spec["base_template"],
            vary=False,
        )
        baseline_sig = variant_paths.signature(baseline["template"], source["code"])
        selected_sig = variant_paths.signature(prepared, source["code"])
        if (
            (pairwise_batch and baseline_sig != selected_sig)
            or baseline_sig not in variant_paths.options(service_id, level, categories)
            or path_counts[baseline_sig] > path_counts[selected_sig]
        ):
            # Проверяем выбранный новый путь с родными фразами вместо повторного baseline.
            candidate = gameplay.build_gameplay(
                spec,
                gameplay.fallback_response(spec, seed),
                scenario_id=scenario_id,
                origin="template",
                auto_admit=auto_admit,
            )
            verdict = await coherence(db, candidate)
            if verdict is None:
                stand_unavailable = True
                catalog_fallback = auto_admit
                coherence_info = {"status": "unchecked", "reason": "Проход связности недоступен."}
            elif not verdict:
                coherence_info = {
                    "status": "passed",
                    "reason": "Шаблонная вариация прошла проверку.",
                }
            if verdict:
                # Вариация противоречива и с родными фразами — берём путь каркаса, как в
                # каталоге (связность проверена ночным прогоном): пакет не обрывается.
                spec = baseline
                catalog_fallback = auto_admit
                coherence_info = {
                    "status": "catalog",
                    "reason": "Новый вариант не прошёл проверку связности — взят путь каркаса.",
                }
        else:
            spec = baseline
            catalog_fallback = auto_admit
    if catalog_fallback:
        from app.worker.generators.themes import category
        from app.worker.generators.variation import checked

        # Метка уровня каталога не описывает сложность запрошенного занятия. Разрешён
        # только целый каталожный путь с нужными событиями, без непроверенной вариации.
        if not checked(source, level):
            compatible = sorted(
                (
                    item
                    for item in gameplay.templates()
                    if item["service_id"] == service_id and checked(item, level)
                ),
                key=lambda item: item["code"],
            )
            if categories:
                compatible = [t for t in compatible if category(t) in categories] or compatible
            if not compatible:
                raise GenerationRejected(
                    f"Нет проверенного каталожного пути уровня {level} для службы {service_id}. "
                    "Понижение сложности запрещено; повторите генерацию после восстановления "
                    "проверки связности."
                )
            counts = {
                item["code"]: (
                    path_counts[variant_paths.signature(item, item["code"])],
                    usage[item["code"]],
                )
                for item in compatible
            }
            least = min(counts.values())
            compatible = [t for t in compatible if counts[t["code"]] == least]
            source = compatible[seed % len(compatible)]
        spec = gameplay.gameplay_input(
            service_id=service_id,
            level=level,
            seed=seed,
            weight=weight,
            template=source,
            prepared=source,
        )
        spec["catalog_fallback"] = True
        accepted = None
        fallback = True
        coherence_info = {
            "status": "catalog",
            "reason": "Взят каталожный путь без вариации; check_file пройден.",
        }
    response = accepted or gameplay.fallback_response(spec, seed)
    origin = "template" if fallback else "llm"
    data = gameplay.build_gameplay(
        spec, response, scenario_id=scenario_id, origin=origin, auto_admit=auto_admit
    )
    from app.worker.generators.variation import describe

    metadata = {
        "model": llm.name,
        "prompt_version": GAMEPLAY_PROMPT_VERSION,
        "prompt_sha256": hashlib.sha256(gameplay.PROMPT.read_bytes()).hexdigest(),
        "source_version": spec["source_version"],
        "scene": spec["scene"],
        "constructor": {
            "variant_signature": variant_paths.signature(data, spec["base_template"]["code"]),
            "template": spec["base_template"]["code"],
            "level": data["level"],
            "requested_level": level,
            "seed": seed,
            "variation": describe(data, spec["base_template"]),
            "pairwise_features": pairwise.features(data),
        },
        "input": (correction_spec or spec)["facts"],
        "phrases": {
            "reports": gameplay.report_phrase_ids(data),
            "events": {},
        },
        "attempts": attempts,
        "fallback_used": fallback,
        "auto_admitted": auto_admit,
        "coherence": {**coherence_info, "stand_unavailable": stand_unavailable},
        "validation": dict.fromkeys(("schema", "facts", "links", "reachability"), True),
    }
    if correction:
        metadata["correction"] = {
            "teacher_note": correction["note"],
            "previous_scenario_id": correction["previous_scenario_id"],
        }
    if coherence_info["status"] == "unchecked":
        data["teacher_comment"] += " Связность не проверена: " + coherence_info["reason"]
    elif catalog_fallback:
        data["teacher_comment"] += " " + coherence_info["reason"]
        if stand_unavailable:
            data["teacher_comment"] += " Проход связности недоступен."
    if participant_id is not None:
        from app.worker.generators.personalization import selection

        personal = selection(data, weak_spots or {}, focused, str(participant_id))
        metadata["constructor"]["personalization"] = personal
        data["teacher_comment"] += " Причина подбора: " + personal["explanation"]
    validate_json(
        metadata, "https://arm112.local/contracts/scenario-generation-metadata.schema.json"
    )
    manifests: dict[str, dict[str, dict[str, Any]]] = {}

    async def audio(path: str, text: str) -> dict[str, Any] | None:
        root = path.split("/", 1)[0]
        if root not in manifests:
            manifests[root] = load_audio(gameplay.VOICES, Path(root) / "manifest.json")
        return await audio_ref(db, gameplay.VOICES, manifests[root], path, text)

    plan = await training_plan(data, audio)
    row = Scenario(
        **{
            **scenario_row(data),
            "origin": origin,
            "status": "approved" if auto_admit else "draft",
            "teacher_comment": data["teacher_comment"],
        },
        author_id=author_id,
        generation_metadata=metadata,
    )
    db.add(row)
    await db.flush()
    await store_plan(db, row.id, row.version, author_id, plan)
    db.add(
        AuditLog(
            actor_id=author_id,
            action="autoAdmitScenario" if auto_admit else "generateScenario",
            entity="scenario",
            entity_id=str(row.id),
            before=None,
            after={
                "version": row.version,
                "origin": row.origin,
                "status": row.status,
                "prompt_version": GAMEPLAY_PROMPT_VERSION,
                "fallback_used": fallback,
                "template": spec["template"]["code"],
            },
            ip=None,
        )
    )
    return row


async def generate_bank_one(
    db: AsyncSession,
    llm: LLMProvider,
    *,
    scenario_id: UUID,
    author_id: UUID,
    service_id: str,
    level: int,
    seed: int,
    auto_admit: bool,
    weight: int | None = None,
) -> Scenario:
    """Две попытки модели, затем проверенный fallback с честным origin=template.

    Фразы шаблонного пути — тоже из банка, выбраны случайно среди подходящих.
    """
    existing = await db.get(Scenario, scenario_id)
    if existing is not None:
        if existing.generation_metadata is None:
            raise GenerationRejected("Идентификатор занят сценарием другого происхождения.")
        return existing
    service = await db.get(Service, service_id)
    target = await db.scalar(
        select(CallTarget)
        .join(Brigade, Brigade.id == CallTarget.brigade_id)
        .where(
            CallTarget.service_id == service_id,
            CallTarget.is_active.is_(True),
            Brigade.is_active.is_(True),
            Brigade.service_id == service_id,
        )
        .order_by(CallTarget.phone_ext)
        .limit(1)
    )
    if service is None or not service.is_active or target is None or target.brigade_id is None:
        raise GenerationRejected("Нужны активная служба, её бригада и соответствующий адресат.")
    spec = generation_input(service_id=service_id, level=level, seed=seed, weight=weight)
    prompt = json.dumps(spec["facts"], ensure_ascii=False, sort_keys=True)
    attempts: list[dict[str, Any]] = []
    accepted: dict[str, Any] | None = None
    for number in (1, 2):
        started = time.monotonic()
        request_prompt = prompt
        if number == 2:
            request_prompt = json.dumps(
                {
                    **spec["facts"],
                    "description_facts": (
                        f"{spec['facts']['address']}: {spec['facts']['situation']}"
                    ),
                },
                ensure_ascii=False,
                sort_keys=True,
            )
        response = await llm.complete_json(request_prompt)
        error = None
        try:
            if response is None:
                raise GenerationRejected("Провайдер недоступен или ответ отклонён.")
            validate_response(spec["facts"], response)
            chosen_phrases(spec, response)
            accepted = response
        except GenerationRejected as exc:
            error = str(exc)
        attempts.append(
            {
                "number": number,
                "accepted": accepted is not None,
                "error": error,
                "duration_seconds": round(time.monotonic() - started, 3),
                "diagnostics": getattr(llm, "last_diagnostics", {}),
            }
        )
        if accepted is not None:
            break
    fallback = accepted is None or not getattr(llm, "is_generative", False)
    response = accepted or fallback_response(spec, seed)
    value, plan = build_scenario(
        spec,
        response,
        scenario_id=scenario_id,
        brigade_id=target.brigade_id,
        target_id=target.id,
        phone_ext=target.phone_ext,
        origin="template" if fallback else "llm",
        auto_admit=auto_admit,
    )
    metadata = {
        "model": llm.name,
        "prompt_version": PROMPT_VERSION,
        "prompt_sha256": hashlib.sha256(
            (ROOT / "apps/api/app/worker/prompts/scenario_generation_system.md").read_bytes()
        ).hexdigest(),
        "source_version": spec["source_version"],
        "scene": spec["scene"],
        "constructor": spec["constructor"],
        "input": spec["facts"],
        "phrases": phrase_ids(spec, response),
        "attempts": attempts,
        "fallback_used": fallback,
        "auto_admitted": auto_admit,
        "validation": dict.fromkeys(("schema", "facts", "links", "reachability"), True),
    }
    validate_json(
        metadata, "https://arm112.local/contracts/scenario-generation-metadata.schema.json"
    )
    row = Scenario(
        **{**value, "id": scenario_id}, author_id=author_id, generation_metadata=metadata
    )
    db.add(row)
    await db.flush()
    await store_plan(db, row.id, row.version, author_id, plan)
    db.add(
        AuditLog(
            actor_id=author_id,
            action="autoAdmitScenario" if auto_admit else "generateScenario",
            entity="scenario",
            entity_id=str(row.id),
            before=None,
            after={
                "version": row.version,
                "origin": row.origin,
                "status": row.status,
                "prompt_version": PROMPT_VERSION,
                "fallback_used": fallback,
            },
            ip=None,
        )
    )
    return row
