from pathlib import Path
from typing import Any, Protocol


class LLMProvider(Protocol):
    name: str

    async def complete_json(self, prompt: str) -> dict[str, Any] | None: ...


class EmbeddingsProvider(Protocol):
    name: str

    async def similarity(self, left: str, right: str) -> float | None: ...


class STTProvider(Protocol):
    name: str

    async def transcribe(self, path: Path) -> str: ...


class TTSProvider(Protocol):
    name: str

    async def resolve(self, voice_profile: str, phrase_id: str) -> tuple[str, int]: ...
