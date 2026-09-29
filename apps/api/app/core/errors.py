"""Форматирование ошибок валидации запроса для ответа 422."""

from fastapi.exceptions import RequestValidationError


def format_validation_errors(exc: RequestValidationError) -> list[dict[str, object]]:
    """Разворачивает ошибки pydantic в путь к полю и причину для каждой из них."""
    result = []
    for error in exc.errors():
        path = ".".join(str(part) for part in error["loc"] if part != "body")
        result.append({"field": path, "reason": error["msg"]})
    return result
