from pathlib import Path

from app.worker.providers.interfaces import Recognition


class NullSTT:
    name = "off"

    async def transcribe(self, path: Path) -> str:
        # MVP-STUB: контракт возвращает строку; пустая строка явно означает отсутствие STT.
        return ""

    async def recognize(self, path: Path, hints: tuple[str, ...] = ()) -> Recognition:
        # MVP-STUB brikkerdev: распознавания нет — пустой текст без уверенности, как и transcribe.
        return Recognition("", None)
