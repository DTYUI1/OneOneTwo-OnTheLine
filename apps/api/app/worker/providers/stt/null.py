from pathlib import Path


class NullSTT:
    name = "off"

    async def transcribe(self, path: Path) -> str:
        # MVP-STUB: контракт возвращает строку; пустая строка явно означает отсутствие STT.
        return ""
