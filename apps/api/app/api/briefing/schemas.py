from typing import Annotated, Literal

from pydantic import Field

from app.api.foundation.schemas import ContractModel


class BriefingCheckInput(ContractModel):
    text: Annotated[str, Field(max_length=1000)] = Field(
        description="Вводная бригаде: распознанная фраза диспетчера или фраза, собранная по "
        "частям (адрес и что случилось)."
    )


class BriefingCheck(ContractModel):
    address: Literal["ok", "wrong", "missing"] = Field(
        description="Адрес, который поняла бригада: ok — адрес эталона (улица, её тип и дом), "
        "wrong — другой адрес (бригада поедет туда), missing — адреса или номера дома нет."
    )
    heard_address: str | None = Field(
        description="Адрес, как его поняла бригада; null — адреса не прозвучало."
    )
    incident: bool = Field(
        description="Совпадает ли названный повод с происшествием сценария. false также при "
        "отсутствующем поводе; понятный неверный повод не мешает полной вводной."
    )
    complete: bool = Field(
        description="Вводная полная — адрес назван и понятный повод прозвучал, даже если "
        "адрес или повод неверны: событие brigade_briefing с этой фразой отправит бригаду."
    )
    readback: str | None = Field(
        description="Ответ бригады на полную вводную: повтор адреса «Повторяю: …». null — "
        "вводная неполная или адрес повторит ловушка сценария (readback_error)."
    )
    ask_again: str | None = Field(
        description="Что бригада переспрашивает на неполную вводную; null — вводная полная."
    )
