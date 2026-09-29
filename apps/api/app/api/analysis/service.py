"""C-06: разбор попытки и аналитика занятия по I-EVAL/I-TIME (contracts/C01_INTERFACES.md).

Ответы не содержат эталон и ожидаемый текст. Время считается общим `evalcore.timing` по
снимку методики занятия; оценка берётся из сохранённой Evaluation без новой формулы балла.
Слой, который ещё не выполнен (LLM-судья, проверка адреса V-02, грамотность), помечается
честно: обязательный слой не done → оценка partial с причиной.
"""

import re
from dataclasses import asdict
from datetime import UTC, datetime
from statistics import fmean
from typing import Any
from uuid import UUID

from evalcore.adaptive import recommend_level  # type: ignore[import-untyped]
from evalcore.iteration_contract import CalibrationObservation  # type: ignore[import-untyped]
from evalcore.timing import calculate_timing  # type: ignore[import-untyped]
from evalcore.timing_contract import TimingInput, TimingResult  # type: ignore[import-untyped]
from fastapi import HTTPException, Request
from pydantic import TypeAdapter
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.c01 import C01Input
from app.api.cards import repo as card_repo
from app.api.clock import service as clock
from app.api.evaluations import repo as evaluation_repo
from app.api.training.gating import report_schedule
from app.core.evaluation_details import unpack_explanation
from app.core.models import (
    Assignment,
    Call,
    Card,
    CardEvent,
    ClockSample,
    Evaluation,
    MessageDelivery,
    Participant,
    Prediction,
    Scenario,
    Session,
    TeacherOverride,
)

# Версия способа сборки разбора: меняется при изменении правил слоёв/счётчиков.
METHODOLOGY_VERSION = "c06-analysis-1"
# AI-оценка обязательна по ТЗ: без выполненного LLM-слоя оценка остаётся partial.
REQUIRED_LAYERS = ["rules", "llm"]
TIMING_KINDS = {"deliver": "deliver", "open": "open", "redirect": "redirect"}
ERROR_CRITERIA = {"routing": "routing", "status_flow": "status_flow", "call": "call"}


class AttemptAnalysisView(C01Input):
    contract_name = "AttemptAnalysis"


class SessionAnalyticsView(C01Input):
    contract_name = "SessionAnalytics"


def iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def shown_at(value: dict[str, Any], card: Card) -> str | None:
    """Момент, когда строка карточки появилась на АРМ обучаемого (начало реакции v3).

    Q&A Q11: норматив 30 с идёт «с момента появления сообщения в строке состояния».
    Выдача scheduler'ом (`appeared_at`) раньше: обучаемый мог ещё входить в систему,
    и отсчёт шёл бы без него. Момент показа — первый `deliver`, нормализованный тем же
    общим расчётом и по тем же правилам часов, что остальные действия обучаемого: иначе
    пачка событий, дошедшая после обрыва связи, дала бы «Принята» раньше показа
    (non_monotonic). Без подтверждённых часов это серверное время deliver. Карточку,
    которую обучаемый так и не увидел, реакцией не судим — направления у неё нет.
    """
    deliver = next((e for e in value["events"] if e["kind"] == "deliver"), None)
    if deliver is None:
        return iso(card.delivered_at) if card.delivered_at else None
    probe = TypeAdapter(TimingInput).validate_python({**value, "events": [deliver], "waiting": []})
    moment: str = calculate_timing(probe).evidence[0].normalized_at
    return moment


async def timing_input(db: AsyncSession, row: Any, lesson: Session) -> dict[str, Any]:
    """Адаптер C-02: события карточки → TimingInput по снимку методики занятия."""
    card = row["Card"]
    policy = lesson.timing_policy
    events: list[dict[str, Any]] = []
    stored = (
        await db.execute(
            select(CardEvent, ClockSample)
            .outerjoin(ClockSample, ClockSample.id == CardEvent.clock_sample_id)
            .where(CardEvent.card_id == card.id)
            .order_by(CardEvent.server_ts, CardEvent.id)
        )
    ).all()
    for event, sample in stored:
        if event.type == "status_change":
            kind, state = "status", event.payload.get("state")
        elif event.type in TIMING_KINDS:
            kind, state = TIMING_KINDS[event.type], None
        else:
            continue
        events.append(
            {
                "event_id": str(event.id),
                "kind": kind,
                "state": state,
                "client_ts": iso(event.client_ts),
                "server_ts": iso(event.server_ts),
                # Без подтверждённого образца v2 время клиента оценочное (server_fallback).
                "clock": clock.as_contract(sample) if sample is not None else None,
            }
        )
    # Прерванная попытка (перезапуск тренировки) замирает на прерывании, а не тикает до «сейчас».
    observed = card.closed_at or card.interrupted_at or lesson.finished_at or datetime.now(UTC)
    deliveries = (
        await db.execute(
            select(MessageDelivery, Call.answered_at)
            .join(Call, Call.id == MessageDelivery.call_id)
            .where(MessageDelivery.card_id == card.id)
            .order_by(MessageDelivery.delivered_at, MessageDelivery.id)
        )
    ).all()
    # Подтверждённое ожидание (C-04, решение 27.09): бригада работает с отправки или с
    # нужного статуса до готовности доклада. Если диспетчер ответил на её звонок позже,
    # это уже его время, а не ожидание. Выдачи до 0012 — от ответа на звонок до реплики.
    waiting: list[dict[str, Any]] = []
    for delivery, answered in deliveries:
        if delivery.waiting_started_at is not None and delivery.ready_at is not None:
            start, end = delivery.waiting_started_at, delivery.ready_at
        elif answered is not None:
            start, end = answered, delivery.delivered_at
        else:
            continue
        if end > start:
            waiting.append(
                {"message_id": str(delivery.id), "started_at": iso(start), "ended_at": iso(end)}
            )
    # Бригада ещё работает (доклад не готов) или готова, но диспетчер не ответил.
    for report in await report_schedule(db, card):
        if report.issued or report.waiting_started_at is None or report.ready_at is None:
            continue
        if report.waiting_started_at >= observed:
            continue
        waiting.append(
            {
                "message_id": str(report.identity[0]),
                "started_at": iso(report.waiting_started_at),
                "ended_at": iso(report.ready_at) if report.ready_at <= observed else None,
            }
        )
    settings = lesson.settings_snapshot
    value: dict[str, Any] = {
        "snapshot_id": str(lesson.id),
        "policy": policy,
        "legacy_reaction_normative_s": settings.get("reaction_normative_s", 30),
        "legacy_handling_normative_s": settings.get("handling_normative_s", 180),
        "appeared_at": iso(card.appeared_at),
        "observed_at": iso(observed),
        "events": events,
        "waiting": waiting,
    }
    if policy is not None and policy["timing_version"] == 3:
        moment = shown_at(value, card)
        if moment is not None:
            direct = {
                "event_id": str(card.id),
                "kind": "direct",
                "state": None,
                "client_ts": moment,
                "server_ts": moment,
                "clock": None,
            }
            value["events"] = [direct, *events]
    return value


async def card_timing(db: AsyncSession, card: Card, lesson: Session) -> TimingResult:
    """Время карточки по снимку методики — одно и то же для разбора и критериев V-01."""
    value = TypeAdapter(TimingInput).validate_python(await timing_input(db, {"Card": card}, lesson))
    return calculate_timing(value)


def layers(evaluation: Evaluation, has_information: bool) -> list[dict[str, Any]]:
    """Слои I-EVAL по сохранённой оценке; невыполненный слой не выдаётся за done."""
    explanations = evaluation.explanation if isinstance(evaluation.explanation, dict) else {}
    rules_done = bool(evaluation.rules_scores)
    llm_done = isinstance(evaluation.llm_scores, dict) and bool(evaluation.llm_scores)
    info = evaluation.model_info or {}
    result = [
        {
            "layer": "rules",
            "status": "done" if rules_done else "unavailable",
            "version": str(info.get("rules")) if rules_done else None,
            "reason": None if rules_done else "Детерминированные критерии не рассчитаны.",
            "evidence": [
                f"{key}: {float(score):.2f}"
                for key, score in sorted(evaluation.rules_scores.items())
            ],
            "explanation": "Детерминированные критерии evalcore по событиям попытки."
            if rules_done
            else str(explanations.get("rules", "Оценка по правилам недоступна.")),
        },
        {
            "layer": "llm",
            "status": "done" if llm_done else "pending",
            "version": str(info.get("llm")) if llm_done else None,
            "reason": None if llm_done else "Локальный ИИ-судья ещё не вернул проверенный ответ.",
            "evidence": [
                f"{key}: {float(score):.2f}"
                for key, score in sorted((evaluation.llm_scores or {}).items())
            ],
            "explanation": "Оценка свободного текста локальной моделью."
            if llm_done
            else "ИИ-оценка комментария не выполнена; итог — по правилам.",
        },
    ]
    address_done = rules_done and "address" in evaluation.rules_scores
    result.append(
        {
            "layer": "address",
            "status": "done" if address_done else "unavailable",
            "version": str(info.get("rules")) if address_done else None,
            "reason": None if address_done else "Критерий адреса не рассчитан.",
            "evidence": [f"address: {float(evaluation.rules_scores['address']):.2f}"]
            if address_done
            else [],
            # V-02: ручной адрес из current.address, сокращения нормализуются.
            "explanation": "Ручной адрес диспетчера сравнён с эталоном по компонентам "
            "(«ул.» = «улица», регистр, «ё»); похожая другая улица не засчитывается."
            if address_done
            else "Проверка адреса недоступна: оценка по правилам не рассчитана.",
        }
    )
    grammar_done = rules_done and "spelling" in evaluation.rules_scores
    grammar_errors = spelling_errors(evaluation)
    result.append(
        {
            "layer": "grammar",
            "status": "done" if grammar_done else "unavailable",
            "version": str(info.get("rules")) if grammar_done else None,
            "reason": None
            if grammar_done
            else "Грамотность не проверялась: в настройках занятия нет её веса.",
            "evidence": [
                f"spelling: {float(evaluation.rules_scores['spelling']):.2f}",
                f"ошибок: {grammar_errors}",
            ]
            if grammar_done
            else [],
            # 28.09: словарь OpenCorpora + словарь 112 + улицы; без ИИ и интернета.
            "explanation": "Комментарий проверен по словарю русского языка, словарю 112 и "
            "справочнику улиц; имена, сокращения и улица сценария ошибкой не считаются."
            if grammar_done
            else "Грамотность не проверялась: в настройках занятия нет её веса.",
        }
    )
    for layer, reason in (("semantic", "Семантическое сравнение с эталоном не подключено."),):
        result.append(
            {
                "layer": layer,
                "status": "unavailable",
                "version": None,
                "reason": reason,
                "evidence": [],
                "explanation": reason,
            }
        )
    result.append(
        {
            "layer": "information",
            "status": "unavailable" if has_information else "not_applicable",
            "version": None,
            "reason": "Оценка по предъявленным сведениям (V-02) не подключена."
            if has_information
            else None,
            "evidence": [],
            "explanation": "В попытке были учебные сообщения бригады."
            if has_information
            else "Сценарий без учебных сообщений бригады.",
        }
    )
    return result


def spelling_errors(evaluation: Evaluation | None) -> int | None:
    """Число ошибок критерия грамотности (evalcore/comment.py) или None — не проверялась."""
    if evaluation is None or "spelling" not in evaluation.rules_scores:
        return None
    _, evidence = unpack_explanation(evaluation.explanation.get("spelling", ""))
    found = re.search(r"ошибок: (\d+)", evidence[0]) if evidence else None
    return int(found.group(1)) if found else int(float(evaluation.rules_scores["spelling"]) < 1)


def error_counts(evaluation: Evaluation | None, timing: dict[str, Any]) -> dict[str, int | None]:
    """ErrorCounts: null — слой не проверен, 0 — проверен без ошибок (I-EVAL)."""
    scores = evaluation.rules_scores if evaluation is not None else {}

    def failed(key: str) -> int | None:
        return None if key not in scores else int(float(scores[key]) < 1)

    overdue = [timing["reaction_overdue"], timing["handling_overdue"]]
    address, grammar = failed("address"), spelling_errors(evaluation)
    return {
        # input = адрес + грамотность; неизвестен, пока не проверен хоть один подслой (I-EVAL).
        "input": None if address is None or grammar is None else address + grammar,
        "address": address,
        "grammar": grammar,
        "routing": failed("routing"),
        "status_flow": failed("status_flow"),
        "timing": None if None in overdue else sum(bool(item) for item in overdue),
        "call": failed("call"),
    }


def evaluation_analysis(
    evaluation: Evaluation, override: TeacherOverride | None, has_information: bool, errors: dict
) -> dict[str, Any]:
    automatic = float(evaluation.total)
    effective = (
        float(override.new_total)
        if override is not None
        and override.decision == "disagree"
        and override.new_total is not None
        else automatic
    )
    items = layers(evaluation, has_information)
    missing = [
        item for item in items if item["layer"] in REQUIRED_LAYERS and item["status"] != "done"
    ]
    complete = evaluation.status == "complete" and not missing
    return {
        "evaluation_id": str(evaluation.id),
        "evaluation_version": evaluation.version,
        "status": "complete" if complete else "partial",
        "automatic_total": automatic,
        "effective_total": effective,
        "effective_override": None
        if override is None
        else {
            "override_id": str(override.id),
            "decision": override.decision,
            "new_total": override.new_total,
            "reason": override.reason,
            "teacher_comment": override.teacher_comment,
            "created_at": iso(override.created_at),
        },
        "required_layers": REQUIRED_LAYERS,
        "layers": items,
        "partial_reasons": []
        if complete
        else [f"Слой {item['layer']}: {item['reason']}" for item in missing]
        or ["Оценка сохранена как частичная."],
        "methodology_version": METHODOLOGY_VERSION,
        "model_versions": {str(k): str(v) for k, v in (evaluation.model_info or {}).items() if v},
        "errors": errors,
        "explanation": (
            f"Итог {effective:.2f}"
            + (" (изменён преподавателем)" if effective != automatic else "")
            + ("; оценка полная." if complete else "; оценка частичная.")
        ),
    }


def prediction_observation(prediction: Prediction, closed_at: datetime | None) -> dict[str, Any]:
    return {
        "prediction_id": str(prediction.id),
        "made_at": iso(prediction.made_at),
        "model_version": prediction.model_version,
        "methodology_version": "prediction-legacy-1",
        "p_success": prediction.p_success,
        "expected_score": prediction.expected_score,
        "expected_time_s": prediction.expected_time_s,
        "p_timeout": prediction.p_timeout,
        "actual_score": prediction.actual_score,
        "actual_time_s": prediction.actual_time_s,
        "actual_timeout": prediction.actual_timeout,
        # Факт дописывается при завершении карточки; отдельного столбца времени нет.
        "actual_at": iso(closed_at) if prediction.actual_score is not None and closed_at else None,
    }


async def build_attempt(db: AsyncSession, row: Any) -> dict[str, Any]:
    card = row["Card"]
    lesson = await db.get(Session, row["session_id"])
    assignment = await db.get(Assignment, card.assignment_id)
    if lesson is None or assignment is None:
        raise HTTPException(404, "Карточка не найдена.")
    timing = asdict(await card_timing(db, card, lesson))
    evaluation = await db.scalar(
        select(Evaluation)
        .where(Evaluation.card_id == card.id)
        .order_by(Evaluation.version.desc())
        .limit(1)
    )
    has_information = (
        await db.scalar(
            select(MessageDelivery.id).where(MessageDelivery.card_id == card.id).limit(1)
        )
        is not None
    )
    errors = error_counts(evaluation, timing)
    analysis = None
    if evaluation is not None:
        override = (await evaluation_repo.latest_overrides(db, [evaluation.id])).get(evaluation.id)
        analysis = evaluation_analysis(evaluation, override, has_information, errors)
    prediction = await db.scalar(select(Prediction).where(Prediction.card_id == card.id))
    return {
        "card_id": str(card.id),
        # I-SESSION: participant_id в HTTP — user UUID внутри занятия, не Participant.id.
        "participant_id": str(row["trainee_id"]),
        "attempt_status": "completed"
        if card.closed_at
        else ("interrupted" if card.interrupted_at else "active"),
        "timing": timing,
        "evaluation": analysis,
        "prediction": None
        if prediction is None
        else prediction_observation(prediction, card.closed_at),
    }


async def get_attempt_analysis(request: Request, card_id: UUID) -> AttemptAnalysisView:
    row = await card_repo.card(
        request.state.db, card_id, request.state.user.id, request.state.user.role
    )
    if row is None:
        raise HTTPException(404, "Карточка не найдена.")
    return AttemptAnalysisView(await build_attempt(request.state.db, row))


def mean(values: list[float]) -> float | None:
    return fmean(values) if values else None


def aggregate_errors(attempts: list[dict[str, Any]]) -> dict[str, int | None]:
    """Сумма по оценённым попыткам; неизвестный слой хотя бы у одной — null (I-EVAL)."""
    evaluated = [a["evaluation"]["errors"] for a in attempts if a["evaluation"] is not None]
    keys = ("input", "address", "grammar", "routing", "status_flow", "timing", "call")
    return {
        key: None
        if not evaluated or any(item[key] is None for item in evaluated)
        else sum(item[key] for item in evaluated)
        for key in keys
    }


def observation(attempt: dict[str, Any], card: Card, level: int, weight: int) -> Any:
    """Попытка занятия → CalibrationObservation для правил V-03 (evalcore.adaptive)."""
    evaluation, timing = attempt["evaluation"], attempt["timing"]
    prediction = attempt["prediction"] or {}
    override = evaluation["effective_override"]
    version = timing["timing_version"]
    return CalibrationObservation(
        card_id=attempt["card_id"],
        prediction_id=prediction.get("prediction_id", ""),
        made_at=prediction.get("made_at", ""),
        # В историю попадают только закрытые карточки (фильтр в recommendation).
        completed_at=iso(card.closed_at) if card.closed_at else "",
        predicted_score=prediction.get("expected_score") or 0.0,
        automatic_score=evaluation["automatic_total"],
        effective_score=evaluation["effective_total"],
        override_id=override["override_id"] if override else None,
        # v3 сравнивает с нормативом активную обработку, как критерий V-01.
        handling_s=timing["active_handling_s"] if version == 3 else timing["handling_s"],
        timing_version=version,
        snapshot_id=timing["snapshot_id"],
        handling_normative_s=timing["handling_normative_s"],
        timing_quality=timing["quality"],
        level=level,
        weight=weight,
    )


def recommendation(
    participant: Participant,
    own: list[dict[str, Any]],
    cards: dict[str, Card],
    weights: dict[UUID, int],
    flags: dict[str, list[Any]],
    verified: int,
) -> dict[str, Any]:
    """V-03: объяснимая рекомендация уровня по завершённым оценённым попыткам занятия."""
    done = [
        a for a in own if a["evaluation"] is not None and cards[a["card_id"]].closed_at is not None
    ]
    history = [
        observation(
            a,
            cards[a["card_id"]],
            participant.level,
            weights.get(cards[a["card_id"]].assignment_id, participant.level * 2),
        )
        for a in done
    ]
    summary = (
        f"Попыток {len(own)}, оценено {sum(a['evaluation'] is not None for a in own)}; "
        f"проверенных измерений времени {verified}."
    )
    try:
        result = recommend_level(
            participant.level,
            history,
            critical_flags_by_card={a["card_id"]: flags.get(a["card_id"], []) for a in done},
        )
    except ValueError as exc:
        return {"recommendation": None, "explanation": f"{summary} Рекомендация недоступна: {exc}"}
    return {"recommendation": asdict(result), "explanation": f"{summary} {result.explanation}"}


async def get_session_analytics(request: Request, session_id: UUID) -> SessionAnalyticsView:
    db = request.state.db
    lesson = await db.get(Session, session_id)
    if lesson is None or lesson.teacher_id != request.state.user.id:
        raise HTTPException(404, "Занятие не найдено.")
    rows = list(
        (
            await db.execute(
                card_repo.card_query()
                .where(Assignment.session_id == session_id)
                .order_by(Card.appeared_at, Card.id)
            )
        ).mappings()
    )
    attempts = [await build_attempt(db, row) for row in rows]
    cards = {str(row["Card"].id): row["Card"] for row in rows}
    weights = {
        assignment_id: weight
        for assignment_id, weight in (
            await db.execute(
                select(Assignment.id, Scenario.weight)
                .join(Scenario, Scenario.id == Assignment.scenario_id)
                .where(Assignment.session_id == session_id)
            )
        ).tuples()
    }
    flags: dict[str, list[Any]] = {}
    for card_id, flagged in (
        await db.execute(
            select(Evaluation.card_id, Evaluation.critical_flags)
            .where(Evaluation.card_id.in_([row["Card"].id for row in rows]))
            .order_by(Evaluation.card_id, Evaluation.version)
        )
    ).tuples():
        flags[str(card_id)] = list(flagged or [])  # последняя версия перезаписывает прежние
    participants = (
        await db.scalars(select(Participant).where(Participant.session_id == session_id))
    ).all()
    trainees = []
    for participant in sorted(participants, key=lambda item: item.workstation_id):
        own = [a for a in attempts if a["participant_id"] == str(participant.user_id)]
        evaluated = [a for a in own if a["evaluation"] is not None]
        # Среднее — только по проверенным измерениям одной версии методики (I-EVAL).
        verified = [a["timing"] for a in own if a["timing"]["quality"] == "verified"]
        reactions = [t["reaction_s"] for t in verified if t["reaction_s"] is not None]
        handling = [t["handling_s"] for t in verified if t["handling_s"] is not None]
        trainees.append(
            {
                "user_id": str(participant.user_id),
                "attempt_count": len(own),
                "completed_count": sum(a["attempt_status"] == "completed" for a in own),
                "interrupted_count": sum(a["attempt_status"] == "interrupted" for a in own),
                "evaluated_count": len(evaluated),
                "complete_evaluation_count": sum(
                    a["evaluation"]["status"] == "complete" for a in evaluated
                ),
                "mean_effective_score": mean(
                    [a["evaluation"]["effective_total"] for a in evaluated]
                ),
                "mean_reaction_s": mean(reactions),
                "reaction_sample_count": len(reactions),
                "mean_handling_s": mean(handling),
                "handling_sample_count": len(handling),
                "errors": aggregate_errors(own),
                "current_level": participant.level,
                **recommendation(participant, own, cards, weights, flags, len(verified)),
            }
        )
    return SessionAnalyticsView(
        {
            "session_id": str(session_id),
            "trainees": trainees,
            "attempts": attempts,
            "methodology_version": METHODOLOGY_VERSION,
        }
    )
