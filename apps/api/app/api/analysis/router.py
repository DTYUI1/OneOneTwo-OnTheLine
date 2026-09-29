from collections.abc import Callable
from typing import Any
from uuid import UUID

from fastapi import Request

from app.api.analysis import service


async def get_attempt_analysis(request: Request, id: UUID) -> service.AttemptAnalysisView:
    return await service.get_attempt_analysis(request, id)


async def get_session_analytics(request: Request, id: UUID) -> service.SessionAnalyticsView:
    return await service.get_session_analytics(request, id)


ENDPOINTS: dict[str, tuple[Callable[..., Any], Any]] = {
    "getAttemptAnalysis": (get_attempt_analysis, service.AttemptAnalysisView),
    "getSessionAnalytics": (get_session_analytics, service.SessionAnalyticsView),
}
