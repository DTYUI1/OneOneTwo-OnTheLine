from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, field_validator

from app.api.foundation.schemas import ContractModel

# bug — ошибка в работе, evaluation — неверная оценка, unclear — непонятно, как работать.
Category = Literal["bug", "evaluation", "unclear", "other"]


class ProblemReportInput(ContractModel):
    category: Category
    text: Annotated[str, Field(min_length=1, max_length=2000, strict=True)]
    # Экран, с которого пришло сообщение, — путь приложения без адреса сервера.
    page: Annotated[str, Field(min_length=1, max_length=300, strict=True)]

    @field_validator("text")
    @classmethod
    def not_blank(cls, value: str) -> str:
        # Сообщение из одних пробелов администратору ничего не скажет.
        if not value.strip():
            raise ValueError("Опишите, что случилось.")
        return value.strip()


class ProblemReport(ContractModel):
    id: UUID
    author_id: UUID
    author_name: str
    author_role: Literal["trainee", "teacher", "admin"]
    category: Category
    text: str
    page: str
    created_at: datetime
