"""Выключаемые провайдеры worker; выбор реализации делается только конфигурацией."""

from app.worker.providers.embeddings.null import NullEmbeddings
from app.worker.providers.llm.local_llamacpp import LocalLlamaCpp
from app.worker.providers.llm.mock import MockLLM
from app.worker.providers.llm.null import NullLLM
from app.worker.providers.stt.local import LocalFasterWhisperSTT
from app.worker.providers.stt.null import NullSTT
from app.worker.providers.tts.prerendered import PrerenderedTTS

__all__ = [
    "LocalFasterWhisperSTT",
    "LocalLlamaCpp",
    "MockLLM",
    "NullEmbeddings",
    "NullLLM",
    "NullSTT",
    "PrerenderedTTS",
]
