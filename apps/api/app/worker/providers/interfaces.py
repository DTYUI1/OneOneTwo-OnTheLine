from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol


class LLMProvider(Protocol):
    name: str

    async def complete_json(self, prompt: str) -> dict[str, Any] | None: ...


class EmbeddingsProvider(Protocol):
    name: str

    async def similarity(self, left: str, right: str) -> float | None: ...


@dataclass(frozen=True)
class Recognition:
    """Распознанная фраза. confidence 0…1; None — сервис уверенность не сообщает."""

    text: str
    confidence: float | None
    # Громкость речи: (уровень речевых кадров, дБ полной шкалы; доля перегруза). None —
    # сервис не меряет или речи нет.
    loudness: tuple[float, float] | None = None


class STTProvider(Protocol):
    name: str

    async def transcribe(self, path: Path) -> str: ...

    async def recognize(self, path: Path, hints: tuple[str, ...] = ()) -> Recognition:
        """`hints` — слова, которые ждём в речи (улица, повод): подсказка распознаванию."""
        ...


class TTSProvider(Protocol):
    name: str

    async def resolve(self, voice_profile: str, phrase_id: str) -> tuple[str, int]: ...
