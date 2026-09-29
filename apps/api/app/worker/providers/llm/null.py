class NullLLM:
    name = "off"

    async def complete_json(self, prompt: str) -> dict[str, object] | None:
        return None
