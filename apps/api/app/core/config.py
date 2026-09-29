from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[4]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")

    api_mode: Literal["mock", "skeleton", "database"] = "mock"
    demo_password: str = "demo-local"
    cookie_secure: bool = False
    ai_provider: Literal["off", "mock", "local"] = "off"
    embeddings_provider: Literal["off", "null"] = "off"
    tts_provider: Literal["prerendered"] = "prerendered"
    stt_provider: Literal["off", "null", "local"] = "off"
    stt_base_url: str = "http://stt:9000"
    stt_timeout_seconds: float = Field(default=30, gt=0, le=300)
    database_url: str = "postgresql+asyncpg://arm112:local-dev-only@localhost:5432/arm112"
    jwt_secret: SecretStr = SecretStr("")
    session_ttl_seconds: int = Field(default=28800, ge=1)
    audio_dir: Path = ROOT / "tmp" / "audio"
    # Учебные доклады бригад (C-04): неизменяемые файлы из data/voices, входят в образ.
    information_audio_dir: Path = ROOT / "data" / "voices"
    # Учебные материалы C-07: в томе пользовательских артефактов, который архивирует backup C-08.
    materials_dir: Path = ROOT / "tmp" / "materials"
    # Папка копий контейнера backup (C-08), только чтение: «Состояние системы» показывает
    # последнюю копию (C-07, FR-7.2). Нет папки — состояние копий неизвестно.
    backup_status_dir: Path = ROOT / "backups"
    worker_poll_interval_seconds: float = Field(default=0.5, gt=0, le=60)
    worker_lease_seconds: int = Field(default=120, ge=5, le=3600)
    worker_max_attempts: int = Field(default=3, ge=1, le=20)
    worker_retry_base_seconds: int = Field(default=2, ge=1, le=300)
    worker_batch_size: int = Field(default=23, ge=1, le=100)
    llm_base_url: str = "http://llm:8080/v1"
    llm_model: str = "qwen3-4b-2507-q4km"
    llm_timeout_seconds: float = Field(default=30, gt=0, le=300)
    llm_temperature: float = Field(default=0.2, ge=0, le=2)
    llm_max_tokens: int = Field(default=300, ge=1, le=4096)
    # Судья на CPU отвечает дольше генератора: отдельный таймаут, по его истечении — partial.
    judge_timeout_seconds: float = Field(default=120, gt=0, le=600)


settings = Settings()
