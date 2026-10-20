import uvicorn

from app.api.screens.hub import WS_MAX_BYTES
from app.core.logging import configure_logging

# Те же параметры — в deploy/docker-compose.dev.yml (`--ws-max-size`); сверяет test_screens.
RUN_OPTIONS = {
    "host": "0.0.0.0",
    "port": 8000,
    "log_config": None,
    "access_log": False,
    # Входящее WS-сообщение больше предела uvicorn не дочитывает (HQ-017, кадры /ws/screen).
    "ws_max_size": WS_MAX_BYTES,
}

if __name__ == "__main__":
    configure_logging()
    uvicorn.run("app.api.main:app", **RUN_OPTIONS)  # type: ignore[arg-type]
