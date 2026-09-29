class NullEmbeddings:
    name = "off"

    async def similarity(self, left: str, right: str) -> float | None:
        return None
