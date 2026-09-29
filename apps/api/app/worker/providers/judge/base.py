"""Интерфейс ИИ-судьи комментария обучаемого (C-06, FR-4.3/4.5)."""

from dataclasses import dataclass, field
from typing import Protocol


@dataclass(frozen=True)
class FewShot:
    """Прошлая попытка с решением преподавателя: учитывается в следующем цикле (FR-4.6)."""

    override_id: str
    comment: str
    decision: str
    teacher_total: float | None
    reason: str


@dataclass(frozen=True)
class JudgeRequest:
    comment: str
    incident: str
    key_facts: list[str]
    few_shot: list[FewShot] = field(default_factory=list)


@dataclass(frozen=True)
class JudgeVerdict:
    facts_found: list[str]
    facts_missing: list[str]
    clarity: float
    explanation: str

    @property
    def completeness(self) -> float:
        """Полнота считается по фактам детерминированно, а не берётся числом у модели."""
        total = len(self.facts_found) + len(self.facts_missing)
        return len(self.facts_found) / total if total else 0.0


class CommentJudge(Protocol):
    name: str

    async def assess(self, request: JudgeRequest) -> JudgeVerdict | None: ...
