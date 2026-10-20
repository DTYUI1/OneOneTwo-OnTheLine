"""C-06: ИИ-слой оценки комментария и его соединение с rules-баллом.

Формула (FR-4.4, документирована здесь и в apps/api/README.md):
    llm = (полнота + понятность) / 2, полнота = найденные ключевые факты / все факты;
    итог = (1 − LLM_WEIGHT) · rules_total + LLM_WEIGHT · llm;
    при критической ошибке оба слоя масштабируются settings.critical_cap.
Ключевые факты берутся из карточки и решения эталона, текст эталона модели не передаётся.
Прошлые решения преподавателя по тому же сценарию (только созданные до этой оценки)
подаются как few-shot: так фидбэк учитывается в следующем цикле без переписывания старых
оценок (FR-4.6).
"""

from dataclasses import asdict
from datetime import datetime
from typing import Any

from evalcore.remarks import default_remarks  # type: ignore[import-untyped]
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models import Assignment, Card, Evaluation, Scenario, TeacherOverride
from app.worker.providers.judge import CommentJudge, FewShot, JudgeRequest, JudgeVerdict

# Доля ИИ-слоя в итоговом балле: правила остаются основой, ИИ уточняет качество текста.
LLM_WEIGHT = 0.2
JUDGE_METHODOLOGY = "c06-judge-1"
FEW_SHOT_LIMIT = 3


def remarks_of(key: str, score: float, text: str) -> list[dict[str, Any]]:
    """Замечание разбора по критерию ИИ-судьи (TC-10); балл без потерь — без замечаний."""
    return [asdict(remark) for remark in default_remarks(key, score, text)]


def key_facts(scenario: Scenario) -> list[str]:
    """Проверяемые сведения комментария по карточке и решению эталона."""
    card: dict[str, Any] = scenario.card
    address = card.get("address", {})
    place = ", ".join(
        part
        for part in (
            address.get("street", ""),
            f"д. {address['house']}" if address.get("house") else "",
        )
        if part
    )
    facts = [
        f"Адрес: {place or address.get('city', '')}",
        f"Происшествие: {card.get('incident_class') or scenario.incident_type_code}",
    ]
    decisions = [
        state
        for state in scenario.reference.get("expected_flow", [])
        if state in ("accepted", "rejected", "redirected")
    ]
    if decisions and decisions[-1] == "accepted":
        facts.append("Решение: карточка принята, силы направлены")
    elif decisions:
        facts.append("Причина, по которой карточка не принята")
    if card.get("victims"):
        facts.append("Сведения о пострадавших")
    return facts


async def few_shot(
    db: AsyncSession, scenario_id: Any, card_id: Any, before: datetime
) -> list[FewShot]:
    """Последние решения преподавателя по этому сценарию, созданные до текущей оценки."""
    rows = (
        await db.execute(
            select(TeacherOverride, Card)
            .join(Evaluation, Evaluation.id == TeacherOverride.evaluation_id)
            .join(Card, Card.id == Evaluation.card_id)
            .join(Assignment, Assignment.id == Card.assignment_id)
            .where(
                Assignment.scenario_id == scenario_id,
                Card.id != card_id,
                TeacherOverride.created_at < before,
            )
            .order_by(TeacherOverride.created_at.desc(), TeacherOverride.id.desc())
            .limit(FEW_SHOT_LIMIT)
        )
    ).all()
    return [
        FewShot(
            override_id=str(override.id),
            comment=str(card.current.get("comment") or ""),
            decision=override.decision,
            teacher_total=override.new_total,
            reason="; ".join(item for item in (override.reason, override.teacher_comment) if item),
        )
        for override, card in rows
    ]


def combine(
    rules_total: float,
    critical: bool,
    cap: float,
    verdict: JudgeVerdict,
    *,
    completion_factor: float = 1.0,
) -> float:
    return combine_scores(
        rules_total,
        critical,
        cap,
        {"comment_completeness": verdict.completeness, "comment_clarity": verdict.clarity},
        completion_factor=completion_factor,
    )


def combine_scores(
    rules_total: float,
    critical: bool,
    cap: float,
    scores: dict[str, Any],
    *,
    completion_factor: float = 1.0,
) -> float:
    """Соединить новые правила с уже проверенным ИИ-слоем, не вызывая модель повторно."""
    llm = (float(scores["comment_completeness"]) + float(scores["comment_clarity"])) / 2
    # rules_total уже уменьшен evalcore в cap раз. Такой же множитель у LLM
    # сохраняет различие между попытками; min(total, cap) снова склеивал их.
    return (1 - LLM_WEIGHT) * rules_total + (
        LLM_WEIGHT * llm * (cap if critical else 1) * completion_factor
    )


async def apply_judge(
    db: AsyncSession,
    judge: CommentJudge,
    evaluation: Evaluation,
    card: Card,
    scenario: Scenario,
    cap: float,
    *,
    completion_factor: float = 1.0,
) -> bool:
    """Выполнить ИИ-слой; True — слой done, оценка complete; False — остаётся partial."""
    comment = str(card.current.get("comment") or "").strip()
    facts = key_facts(scenario)
    examples: list[FewShot] = []
    if not comment:
        # Пустой комментарий оценивать моделью не нужно: сведений нет по определению.
        verdict: JudgeVerdict | None = JudgeVerdict(
            [], facts, 0.0, "Комментарий пуст: ключевые сведения не переданы."
        )
        version = "rule:empty-comment"
    else:
        examples = await few_shot(db, scenario.id, card.id, evaluation.created_at)
        incident = str(scenario.card.get("incident_class") or scenario.incident_type_code)
        verdict = await judge.assess(JudgeRequest(comment, incident, facts, examples))
        version = judge.name
    if verdict is None:
        evaluation.explanation = {
            **evaluation.explanation,
            "llm": "ИИ-судья не вернул проверенный ответ (выключен, таймаут или ответ вне "
            "схемы); итог — по правилам.",
        }
        evaluation.model_info = {**evaluation.model_info, "llm": f"{judge.name}:no-verdict"}
        return False
    evidence = [
        f"Есть: {', '.join(verdict.facts_found) or 'нет'}",
        f"Не хватает: {', '.join(verdict.facts_missing) or 'нет'}",
    ]
    evaluation.llm_scores = {
        # Храним точные слагаемые combine: поздний доклад меняет правила, а не вердикт
        # модели. Округление здесь делало бы итог зависимым от порядка этих событий.
        "comment_completeness": verdict.completeness,
        "comment_clarity": verdict.clarity,
    }
    clarity = f"Понятность следующему звену: {verdict.clarity:.2f}."
    evaluation.explanation = {
        **evaluation.explanation,
        "comment_completeness": {
            "explanation": verdict.explanation,
            "evidence": evidence,
            # TC-10: замечание разбора — последствие, страница памятки, «Повторите: …».
            "remarks": remarks_of(
                "comment_completeness", verdict.completeness, verdict.explanation
            ),
        },
        "comment_clarity": {
            "explanation": clarity,
            "evidence": [verdict.explanation],
            "remarks": remarks_of(
                "comment_clarity",
                verdict.clarity,
                "Запись можно сделать понятнее следующему звену.",
            ),
        },
    }
    evaluation.total = combine(
        float(evaluation.total),
        bool(evaluation.critical_flags),
        cap,
        verdict,
        completion_factor=completion_factor,
    )
    evaluation.model_info = {
        **evaluation.model_info,
        "llm": version,
        "llm_methodology": JUDGE_METHODOLOGY,
        "few_shot": ",".join(item.override_id for item in examples) or "none",
    }
    return True
