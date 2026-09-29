"""HTTP-клиент к необязательному сервису распознавания речи (deploy/stt, профиль compose stt)."""

import logging
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)


class LocalFasterWhisperSTT:
    name = "local:faster-whisper-small"

    def __init__(
        self,
        *,
        base_url: str,
        timeout_seconds: float,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds
        self.transport = transport

    async def transcribe(self, path: Path) -> str:
        try:
            async with httpx.AsyncClient(
                timeout=self.timeout_seconds, transport=self.transport
            ) as client:
                with path.open("rb") as stream:
                    response = await client.post(
                        f"{self.base_url}/transcribe",
                        files={"audio": (path.name, stream, "audio/wav")},
                    )
            response.raise_for_status()
            text = response.json()["text"]
            if not isinstance(text, str):
                raise TypeError("text должен быть строкой")
            return text
        except (httpx.HTTPError, KeyError, TypeError, ValueError) as exc:
            logger.warning(
                "Сервис распознавания речи недоступен или вернул некорректный ответ.",
                extra={"error_type": type(exc).__name__},
            )
            return ""
