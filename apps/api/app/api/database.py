"""Рабочая основа T-007; последующие операции явно возвращают 501."""

import copy
import secrets
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.analysis.router import ENDPOINTS as ANALYSIS_ENDPOINTS
from app.api.audit.router import ENDPOINTS as AUDIT_ENDPOINTS
from app.api.c01 import pending, validate_pending
from app.api.cards.router import ENDPOINTS as CARD_ENDPOINTS
from app.api.cards.service import download_audio
from app.api.catalog.router import ENDPOINTS as CATALOG_ENDPOINTS
from app.api.clock.router import ENDPOINTS as CLOCK_ENDPOINTS
from app.api.content.router import ENDPOINTS as CONTENT_ENDPOINTS
from app.api.evaluations.router import ENDPOINTS as EVALUATION_ENDPOINTS
from app.api.foundation.router import ENDPOINTS as FOUNDATION_ENDPOINTS
from app.api.foundation.router import make_router, require_roles
from app.api.materials.router import ENDPOINTS as MATERIAL_ENDPOINTS
from app.api.packs.router import ENDPOINTS as PACK_ENDPOINTS
from app.api.problem_reports.router import ENDPOINTS as PROBLEM_REPORT_ENDPOINTS
from app.api.progress.router import ENDPOINTS as PROGRESS_ENDPOINTS
from app.api.realtime import RealtimeHub
from app.api.scenarios.router import ENDPOINTS as SCENARIO_ENDPOINTS
from app.api.sessions.router import ENDPOINTS as SESSION_ENDPOINTS
from app.api.spelling.router import ENDPOINTS as SPELLING_ENDPOINTS
from app.api.system.router import BACKUP_ENDPOINTS
from app.api.system.router import ENDPOINTS as SYSTEM_ENDPOINTS
from app.api.training.router import ENDPOINTS as TRAINING_ENDPOINTS
from app.core.audit import transaction_middleware
from app.core.config import Settings
from app.core.contracts import read_json
from app.core.db import Database
from app.core.errors import format_validation_errors
from app.core.security import hash_password
from app.operator.router import router as operator_router

ENDPOINTS = (
    FOUNDATION_ENDPOINTS
    | CATALOG_ENDPOINTS
    | SCENARIO_ENDPOINTS
    | PACK_ENDPOINTS
    | SESSION_ENDPOINTS
    | CARD_ENDPOINTS
    | EVALUATION_ENDPOINTS
    | TRAINING_ENDPOINTS
    | ANALYSIS_ENDPOINTS
    | CLOCK_ENDPOINTS
    | MATERIAL_ENDPOINTS
    | CONTENT_ENDPOINTS
    | PROBLEM_REPORT_ENDPOINTS
    | AUDIT_ENDPOINTS
    | SYSTEM_ENDPOINTS
    | BACKUP_ENDPOINTS
    | SPELLING_ENDPOINTS
    | PROGRESS_ENDPOINTS
)

# Эти схемы уже закреплены D1-контрактом. Реализация T-008 валидирует их Pydantic/JSON Schema,
# а экспорт сохраняет исходное представление nullable и multipart без косметического drift.
CONTRACT_ENDPOINTS = (
    PACK_ENDPOINTS.keys()
    | SESSION_ENDPOINTS.keys()
    | CARD_ENDPOINTS.keys()
    | EVALUATION_ENDPOINTS.keys()
    | TRAINING_ENDPOINTS.keys()
    | ANALYSIS_ENDPOINTS.keys()
    | CLOCK_ENDPOINTS.keys()
    | MATERIAL_ENDPOINTS.keys()
    | CONTENT_ENDPOINTS.keys()
    | PROBLEM_REPORT_ENDPOINTS.keys()
    | AUDIT_ENDPOINTS.keys()
    | SYSTEM_ENDPOINTS.keys()
)
CONTRACT_COMPONENTS = {
    "CardCurrent",
    "CardEvent",
    "Card",
    "Participant",
    "Session",
    "SessionInput",
    "Assignment",
    "AssignmentInput",
    "Call",
    "EventReceipt",
    "StoredEvent",
    "Job",
    "GenerateInput",
    "CriterionResult",
    "Evaluation",
    "OverrideInput",
    "Report",
    "Material",
    "MaterialMetadata",
    "MaterialAssignmentInput",
    "ProblemReport",
    "ProblemReportInput",
    "AuditEntry",
    "AuditPage",
    "SystemStatus",
}


def contract_order(value: Any, template: Any) -> Any:
    """Стабильный порядок ключей уменьшает diff, не подменяя фактическую схему."""
    if isinstance(value, dict) and isinstance(template, dict):
        keys = [key for key in template if key in value]
        keys.extend(key for key in value if key not in template)
        return {key: contract_order(value[key], template.get(key)) for key in keys}
    return value


class DatabaseApp(FastAPI):
    def openapi(self) -> dict[str, Any]:
        if self.openapi_schema is not None:
            return self.openapi_schema
        generated = super().openapi()
        spec = read_json("contracts/openapi.draft.yaml")
        generated["servers"] = [{"url": "/api"}]
        generated["paths"] = {
            path.removeprefix("/api"): methods for path, methods in generated["paths"].items()
        }
        for path, methods in generated["paths"].items():
            for method, operation in methods.items():
                contract = spec["paths"][path][method]
                if operation["operationId"] not in ENDPOINTS:
                    methods[method] = copy.deepcopy(contract)
                elif operation["operationId"] in CONTRACT_ENDPOINTS:
                    methods[method] = copy.deepcopy(contract)
                else:
                    # FastAPI удаляет None из примеров; в контракте это значимые nullable-поля.
                    for code, response in contract["responses"].items():
                        for media, content in response.get("content", {}).items():
                            if "example" in content:
                                operation["responses"][code]["content"][media]["example"] = (
                                    copy.deepcopy(content["example"])
                                )
        # Ещё не реализованные операции сохраняют spec-first формы для параллельной работы.
        components = copy.deepcopy(spec["components"])
        for name, schema in generated.get("components", {}).get("schemas", {}).items():
            if name in CONTRACT_COMPONENTS or name not in components["schemas"]:
                continue
            examples = components["schemas"].get(name, {}).get("examples")
            components["schemas"][name] = schema
            if examples:
                components["schemas"][name]["examples"] = examples
        generated["components"] = components
        self.openapi_schema = contract_order(generated, spec)
        return self.openapi_schema


def pending_endpoint(operation: dict[str, Any]) -> Callable[[Request], Awaitable[None]]:
    async def handle(request: Request) -> None:
        if operation.get("x-implementation-status") == "contract-ready":
            await validate_pending(request, operation)
            pending(operation["x-owner"])
        raise HTTPException(501, "Операция будет реализована в T-008…T-010.")

    return handle


def create_database_app(config: Settings) -> FastAPI:
    spec = read_json("contracts/openapi.draft.yaml")

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if len(config.jwt_secret.get_secret_value().encode()) < 32:
            raise ValueError("Для API_MODE=database задайте JWT_SECRET длиной не менее 32 байт.")
        app.state.database = Database(config.database_url)
        app.state.dummy_password_hash = await hash_password(secrets.token_urlsafe(32))
        app.state.realtime = RealtimeHub(app)
        await app.state.realtime.start()
        try:
            yield
        finally:
            try:
                await app.state.realtime.stop()
            finally:
                await app.state.database.close()

    app = DatabaseApp(
        title=spec["info"]["title"],
        version=spec["info"]["version"],
        description=spec["info"].get("description", ""),
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )
    app.state.config = config
    app.middleware("http")(transaction_middleware)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        return JSONResponse(
            exc.detail
            if isinstance(exc.detail, dict)
            else {"code": f"http_{exc.status_code}", "message": str(exc.detail), "details": {}},
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

    app.include_router(make_router(spec, ENDPOINTS), prefix="/api")
    app.include_router(operator_router)
    # audio_url разыменуется с теми же RBAC и privacy-проверками. Это транспорт файла,
    # а не отдельная бизнес-операция, поэтому OpenAPI D1 не расширяется.
    app.add_api_route(
        "/api/calls/{call_id}/audio",
        download_audio,
        methods=["GET"],
        include_in_schema=False,
        # Запись голоса обучаемого — его персональные данные: администратору не нужна (ТЗ, C-07).
        dependencies=[Depends(require_roles("trainee", "teacher"))],
    )
    for path, methods in spec["paths"].items():
        for method, operation in methods.items():
            op = operation["operationId"]
            if op in ENDPOINTS:
                continue
            app.add_api_route(
                "/api" + path,
                pending_endpoint(operation),
                methods=[method.upper()],
                operation_id=op,
                summary=operation["summary"],
                response_model=None,
                status_code=int(
                    next(code for code in operation["responses"] if code.startswith("2"))
                ),
                dependencies=[Depends(require_roles(*operation["x-roles"]))],
                openapi_extra=operation,
            )

    @app.websocket("/ws")
    async def websocket(socket: WebSocket) -> None:
        await app.state.realtime.connect(socket)

    return app
