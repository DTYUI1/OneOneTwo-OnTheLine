from typing import Annotated
from uuid import UUID

from pydantic import Field

from app.api.foundation.schemas import ContractModel


class SpellingInput(ContractModel):
    text: Annotated[str, Field(max_length=4000, strict=True)]
    card_id: UUID | None = Field(
        default=None,
        description="Карточка, в которой пишет обучаемый: её улица считается верной, а "
        "подсказки разрешены, только если они включены в занятии.",
    )


class SpellingSuggestion(ContractModel):
    start: Annotated[int, Field(ge=0, description="Начало слова в единицах UTF-16, как в JS.")]
    end: Annotated[int, Field(ge=0)]
    word: str
    suggestions: list[str]


class SpellingCheck(ContractModel):
    issues: list[SpellingSuggestion]
