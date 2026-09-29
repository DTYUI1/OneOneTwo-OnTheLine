import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import yaml
from fastapi import FastAPI, Request, WebSocket
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

from app.api.mock import MockBackend
from app.core.config import ROOT, settings
from app.core.errors import format_validation_errors


class ContractApp(FastAPI):
    contract: dict[str, Any]

    def openapi(self) -> dict[str, Any]:
        return self.contract


def create_app() -> FastAPI:
    if settings.api_mode == "database":
        from app.api.database import create_database_app

        return create_database_app(settings)
    spec = yaml.safe_load((ROOT / "contracts/openapi.draft.yaml").read_text(encoding="utf-8"))
    backend = MockBackend(spec)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        yield
        for socket in list(backend.sockets):
            await backend.disconnect(socket)

    app = ContractApp(
        title=spec["info"]["title"],
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )
    app.state.backend = backend
    app.contract = spec

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException) -> JSONResponse:
        return JSONResponse(
            {"code": f"http_{exc.status_code}", "message": str(exc.detail), "details": {}},
            status_code=exc.status_code,
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            {
                "code": "validation_error",
                "message": "Неверный формат запроса.",
                "details": {"errors": format_validation_errors(exc)},
            },
            status_code=422,
        )

    def endpoint(operation: dict):
        async def handle(request: Request):
            if settings.api_mode != "mock" and operation["operationId"] != "health":
                raise HTTPException(501, "Рабочий backend появится в T-007…T-010.")
            try:
                return await backend.handle(request, operation)
            except json.JSONDecodeError as exc:
                raise HTTPException(422, "Ожидается корректный JSON.") from exc

        return handle

    for path, methods in spec["paths"].items():
        for method, operation in methods.items():
            app.add_api_route(
                "/api" + path,
                endpoint(operation),
                methods=[method.upper()],
                operation_id=operation["operationId"],
                include_in_schema=False,
            )

    @app.websocket("/ws")
    async def websocket(socket: WebSocket) -> None:
        if settings.api_mode != "mock":
            await socket.close(code=1013)
            return
        await backend.websocket(socket)

    return app


app = create_app()
