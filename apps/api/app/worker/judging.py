"""C-06: ИИ-слой оценки комментария и его соединение с rules-баллом.

Формула (FR-4.4, документирована здесь и в apps/api/README.md):
    llm = (полнота + понятность) / 2, полнота = найденные ключевые факты / все факты;
    итог = (1 − LLM_WEIGHT) · rules_total + LLM_WEIGHT · llm;
    при критической ошибке rules итог не выше settings.critical_cap.
Ключевые факты берутся из карточки и решения эталона, текст эталона модели не передаётся.
Прошлые решения преподавателя по тому же сценарию (только созданные до этой оценки)
подаются как few-shot: так фидбэк учитывается в следующем цикле без переписывания старых
оценок (FR-4.6).
"""

from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models import Assignment, Card, Evaluation, Scenario, TeacherOverride
from app.worker.providers.judge import CommentJudge, FewShot, JudgeRequest, JudgeVerdict

# Доля ИИ-слоя в итоговом балле: правила остаются основой, ИИ уточняет качество текста.
LLM_WEIGHT = 0.2
JUDGE_METHODOLOGY = "c06-judge-1"
FEW_SHOT_LIMIT = 3


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


def combine(rules_total: float, critical: bool, cap: float, verdict: JudgeVerdict) -> float:
    llm = (verdict.completeness + verdict.clarity) / 2
    total = (1 - LLM_WEIGHT) * rules_total + LLM_WEIGHT * llm
    return min(total, cap) if critical else total


async def apply_judge(
    db: AsyncSession,
    judge: CommentJudge,
    evaluation: Evaluation,
    card: Card,
    scenario: Scenario,
    cap: float,
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
        "comment_completeness": round(verdict.completeness, 4),
        "comment_clarity": round(verdict.clarity, 4),
    }
    evaluation.explanation = {
        **evaluation.explanation,
        "comment_completeness": {"explanation": verdict.explanation, "evidence": evidence},
        "comment_clarity": {
            "explanation": f"Понятность следующему звену: {verdict.clarity:.2f}.",
            "evidence": [verdict.explanation],
        },
    }
    evaluation.total = combine(
        float(evaluation.total), bool(evaluation.critical_flags), cap, verdict
    )
    evaluation.model_info = {
        **evaluation.model_info,
        "llm": version,
        "llm_methodology": JUDGE_METHODOLOGY,
        "few_shot": ",".join(item.override_id for item in examples) or "none",
    }
    return True
