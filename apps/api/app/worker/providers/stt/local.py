"""HTTP-клиент к необязательному сервису распознавания речи (deploy/stt, профиль compose stt)."""

import logging
import re
from pathlib import Path

import httpx

from app.worker.providers.interfaces import Recognition

logger = logging.getLogger(__name__)
# language=ru направляет модель, но не запрещает ей выдавать другие алфавиты.
_NON_RUSSIAN = re.compile(r"""[^А-Яа-яЁё0-9\s.,!?;:…—–\-«»"'()/№%+]+""")


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
        return (await self.recognize(path)).text

    async def recognize(self, path: Path, hints: tuple[str, ...] = ()) -> Recognition:
        """Текст и уверенность фразы. Сбой сервиса — пустой текст: доклад не расслышан.

        `hints` уходят в Whisper как hotwords: редкую улицу («Дубнинская») он иначе
        пишет похожим словом («Дубницкая»).
        """
        try:
            async with httpx.AsyncClient(
                timeout=self.timeout_seconds, transport=self.transport
            ) as client:
                with path.open("rb") as stream:
                    response = await client.post(
                        f"{self.base_url}/transcribe",
                        files={"audio": (path.name, stream, "audio/wav")},
                        data={"hotwords": " ".join(hints)} if hints else None,
                    )
            response.raise_for_status()
            body = response.json()
            text = body["text"]
            if not isinstance(text, str):
                raise TypeError("text должен быть строкой")
            text = " ".join(_NON_RUSSIAN.sub(" ", text).split())
            if not any(char.isalnum() for char in text):
                text = ""
            # Образ до DT-05 уверенности не возвращает: тогда её нет, а не «уверен».
            confidence = body.get("confidence")
            if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
                confidence = None
            level = body.get("loudness")
            loudness = (
                (float(level["speech_dbfs"]), float(level["clipped_share"]))
                if isinstance(level, dict)
                else None
            )
            return Recognition(text, None if confidence is None else float(confidence), loudness)
        except (httpx.HTTPError, KeyError, TypeError, ValueError) as exc:
            logger.warning(
                "Сервис распознавания речи недоступен или вернул некорректный ответ.",
                extra={"error_type": type(exc).__name__},
            )
            return Recognition("", None)
