from typing import Annotated, Literal

from pydantic import Field

from app.api.foundation.schemas import ContractModel

# Виды доклада службе — те же, что у вариантов ответа (call_hangup.report_choices), кроме
# extra: лишние догадки по словам не отличить от сведений.
VoiceReportChoice = Literal["full", "no_who", "no_address", "no_card", "no_change"]
# Части доклада по памятке ДДС, с. 32 (call_hangup.report_parts).
VoiceReportPart = Literal["who", "address", "card", "change"]
# Чего не хватило в части «адрес и повод»: адреса (улица, дом) или повода.
VoiceReportAddressGap = Literal["place", "reason"]
# Громкость фразы (evalcore.loudness): тихо, в норме, громко.
VoiceReportLoudness = Literal["quiet", "ok", "loud"]


class VoiceReport(ContractModel):
    text: str = Field(description="Распознанный текст фразы; пусто — речи не услышано.")
    confidence: Annotated[float, Field(ge=0, le=1)] | None = Field(
        description="Уверенность распознавания 0…1; null — сервис её не сообщает."
    )
    choice: VoiceReportChoice | None = Field(
        description="Вид доклада по ключевым сведениям; null — не расслышано (пусто или "
        "уверенность ниже порога), доклад повторяется."
    )
    parts: list[VoiceReportPart] = Field(
        default_factory=list,
        description="Какие части памятки ДДС, с. 32, прозвучали, в порядке памятки: who — кто "
        "вы, address — адрес и повод, card — карточка, change — что изменилось. Пусто — не "
        "расслышано или ничего не прозвучало.",
    )
    address_gap: VoiceReportAddressGap | None = Field(
        default=None,
        description="Чего не хватило в части «адрес и повод» (служба переспрашивает одним "
        "вопросом именно это): place — адреса (улица, дом), reason — адрес есть, нет повода. "
        "null — часть прозвучала или фраза не расслышана.",
    )
    loudness: VoiceReportLoudness | None = Field(
        default=None,
        description="Громкость речи во фразе: quiet — слишком тихо, ok — в норме, loud — "
        "слишком громко или с перегрузом. null — сервис распознавания громкость не меряет "
        "или речи не услышано.",
    )
    spell_street: str | None = Field(
        default=None,
        description="Похожая улица Москвы (TC-03, data/confusable_streets.json): адрес "
        "прозвучал, а улицу карточки легко спутать с этой — дежурный службы просит повторить "
        "улицу по буквам. null — адрес не прозвучал или у улицы нет похожей.",
    )
