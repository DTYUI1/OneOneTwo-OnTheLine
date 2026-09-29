from app.worker.providers.judge.base import JudgeRequest, JudgeVerdict


class NullJudge:
    """ИИ выключен: слой llm остаётся невыполненным, оценка — partial."""

    name = "off"

    async def assess(self, request: JudgeRequest) -> JudgeVerdict | None:
        return None
