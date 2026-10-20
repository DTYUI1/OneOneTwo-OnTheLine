"""Рекомендации к дальнейшему обучению (GP-14, рекомендации организаторов 16.10, п. 5, 9, 10).

После каждой оценённой карточки обучаемый и преподаватель видят, что подтянуть и что дальше.
Слабые места — критерии оценки с самым низким средним баллом по последним карточкам; совет —
одна фраза на критерий. Следующий шаг — текущая ступень пути (evalcore/progress.py). То же
слабое место берёт тренировка, когда готовит сценарий (`app.api.training.autogen`).

Прошлая рекомендация (TC-11) — та, что была до новой попытки: по карточкам до неё. Новая
попытка помечает каждое её слабое место «выполнена» (критерий проверялся и выполнен
полностью), «не выполнена» (балл ниже полного) или «не проверялась» (сценарий его не требовал).
"""

import re
from collections import defaultdict
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.evaluation_details import unpack_explanation
from app.core.models import Assignment, Card, Evaluation, Participant
from app.core.scored_criteria import criterion_weight

# Сколько последних оценённых карточек учитывается.
WINDOW = 5
# Сколько слабых мест называть: одно-два дела проще удержать, чем список.
FOCUS_LIMIT = 2
# Критерий оценки → (что подтянуть, совет). Неизвестные критерии не называем.
CRITERIA: dict[str, tuple[str, str]] = {
    "reaction_time": ("Время реакции", "Принимайте карточку в работу сразу, как она пришла."),
    "handling_time": (
        "Время обработки",
        "Звоните бригаде сразу после решения и не затягивайте обработку.",
    ),
    "status_flow": ("Ход статусов", "Ставьте статус только после доклада бригады о нём."),
    "routing": (
        "Маршрутизация",
        "До решения по карточке проверьте, что происшествие — профиль вашей службы.",
    ),
    "required_fields": (
        "Обязательные поля",
        "Впишите в «Номер наряда» номер направленной бригады (201…) и заполните комментарий "
        "до закрытия карточки.",
    ),
    "address": (
        "Адрес",
        "Сверяйте адрес из доклада бригады с карточкой и сразу поправляйте ошибку.",
    ),
    "call": ("Звонок", "Звоните тому, кого требует сценарий, и вовремя."),
    "spelling": ("Грамотность", "Перечитывайте комментарий перед сохранением."),
    "comment_keywords": (
        "Комментарий",
        "Запишите в комментарий, что доложила бригада и чем всё закончилось.",
    ),
    "comment_completeness": (
        "Полнота комментария",
        "Запишите в комментарий, что доложила бригада и чем всё закончилось.",
    ),
    "comment_clarity": ("Ясность комментария", "Пишите комментарий короткими понятными фразами."),
}
# Слабые места, под которые тренировка готовит сценарий с ловушкой (app.seed.generator).
TRAINABLE = {"address", "reaction_time", "handling_time", "status_flow"}
# Полный балл критерия: ниже — слабое место, не ниже — рекомендация выполнена.
FULL = 0.999
# Критерий, которого в сценарии нет: оценщик ставит ему 100 % с такой оговоркой
# (как `notApplicable` в разборе обучаемого, apps/web/src/arm/results/debrief.ts).
NOT_APPLICABLE = re.compile(r"не предусмотрен|не обязателен|не заданы|\b0 из 0\b")


@dataclass(frozen=True)
class ScoredAttempt:
    """Оценённая закрытая карточка: баллы по критериям и критерии, которых в сценарии не было."""

    card_id: UUID
    scores: dict[str, float]
    skipped: frozenset[str]


def _skipped(explanation: Any) -> frozenset[str]:
    if not isinstance(explanation, dict):
        return frozenset()
    skipped = set()
    for key, stored in explanation.items():
        if isinstance(stored, dict) and stored.get("weight") == 0:
            skipped.add(str(key))
            continue
        if not isinstance(stored, str | dict):
            continue
        try:
            text, evidence = unpack_explanation(stored)
        except (KeyError, TypeError):
            continue
        if NOT_APPLICABLE.search(" ".join([str(text), *map(str, evidence)])):
            skipped.add(str(key))
    return frozenset(skipped)


async def recent_attempts(
    db: AsyncSession, user_id: UUID, limit: int = WINDOW + 1
) -> list[ScoredAttempt]:
    """Последние оценённые закрытые карточки обучаемого (новые первыми), не больше `limit`."""
    rows = (
        await db.execute(
            select(
                Evaluation.card_id,
                Evaluation.rules_scores,
                Evaluation.llm_scores,
                Evaluation.explanation,
            )
            .join(Card, Card.id == Evaluation.card_id)
            .join(Assignment, Assignment.id == Card.assignment_id)
            .join(Participant, Participant.id == Assignment.participant_id)
            .where(Participant.user_id == user_id, Card.closed_at.is_not(None))
            .order_by(Card.closed_at.desc(), Evaluation.version.desc())
        )
    ).tuples()
    latest: dict[UUID, ScoredAttempt] = {}
    for card_id, rules, llm, explanation in rows:
        if card_id in latest or not rules:
            continue
        latest[card_id] = ScoredAttempt(
            card_id=card_id,
            scores={
                key: float(value)
                for key, value in {**(llm or {}), **rules}.items()
                if isinstance(value, int | float)
                and not isinstance(value, bool)
                and criterion_weight(explanation, key) != 0
            },
            skipped=_skipped(explanation),
        )
        if len(latest) == limit:
            break
    return list(latest.values())


async def recent_scores(db: AsyncSession, user_id: UUID) -> list[dict[str, float]]:
    """Баллы по критериям последних оценённых закрытых карточек обучаемого (новые первыми)."""
    return [item.scores for item in await recent_attempts(db, user_id, WINDOW)]


def weak_spots(scores: list[dict[str, float]]) -> list[str]:
    """Критерии с баллом ниже полного, от самого слабого; только те, что мы умеем назвать."""
    values: dict[str, list[float]] = defaultdict(list)
    for item in scores:
        for key, value in item.items():
            if key in CRITERIA:
                values[key].append(value)
    means = {key: sum(items) / len(items) for key, items in values.items()}
    return sorted((key for key, mean in means.items() if mean < FULL), key=lambda k: means[k])


def focus_of(scores: list[dict[str, float]]) -> list[dict[str, str]]:
    """Что подтянуть (AdviceFocus): не больше двух самых слабых мест."""
    return [
        {"criterion": key, "label": CRITERIA[key][0], "text": CRITERIA[key][1]}
        for key in weak_spots(scores)[:FOCUS_LIMIT]
    ]


def check_status(criterion: str, attempt: ScoredAttempt) -> str:
    """Как новая попытка выполнила слабое место: done, not_done или unchecked (AdviceCheck)."""
    score = attempt.scores.get(criterion)
    if score is None or criterion in attempt.skipped:
        return "unchecked"
    return "done" if score >= FULL else "not_done"


def previous_advice(attempts: list[ScoredAttempt]) -> dict[str, Any] | None:
    """Прошлая рекомендация (PreviousAdvice, openapi): слабые места по карточкам до новой
    попытки и отметка новой попытки. None — попытка одна или прошлых слабых мест не было."""
    if len(attempts) < 2:
        return None
    latest = attempts[0]
    focus = focus_of([item.scores for item in attempts[1 : WINDOW + 1]])
    if not focus:
        return None
    return {
        "card_id": latest.card_id,
        "focus": [{**item, "status": check_status(item["criterion"], latest)} for item in focus],
    }


def advice(
    scores: list[dict[str, float]], current_step: int, step_title: str
) -> dict[str, Any] | None:
    """Рекомендация (Advice, openapi): что подтянуть и следующий шаг; None — карточек нет."""
    if not scores:
        return None
    focus = focus_of(scores)
    next_text = f"Следующий шаг — ступень {current_step}: {step_title}."
    if focus and focus[0]["criterion"] in TRAINABLE:
        next_text += " Тренировка подберёт сценарий, где это место проверяется."
    return {
        "based_on": len(scores),
        "focus": focus,
        "next_step": current_step,
        "next": next_text,
        "summary": (
            "Подтяните: " + ", ".join(item["label"].lower() for item in focus) + "."
            if focus
            else "Ошибок в последних карточках нет — переходите дальше."
        ),
    }
