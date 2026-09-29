import uvicorn

from app.core.logging import configure_logging

if __name__ == "__main__":
    configure_logging()
    uvicorn.run("app.api.main:app", host="0.0.0.0", port=8000, log_config=None, access_log=False)
