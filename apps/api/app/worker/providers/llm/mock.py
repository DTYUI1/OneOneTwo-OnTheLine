import hashlib


class MockLLM:
    """MVP-STUB: детерминированный ответ для проверки интеграции без модели."""

    name = "mock"

    async def complete_json(self, prompt: str) -> dict[str, object]:
        digest = hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:12]
        return {"provider": self.name, "fixture": digest}
