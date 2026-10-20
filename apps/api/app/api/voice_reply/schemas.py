from typing import Annotated

from pydantic import Field

from app.api.foundation.schemas import ContractModel
from app.api.voice_report.schemas import VoiceReportLoudness


class VoiceReply(ContractModel):
    text: str = Field(description="Распознанный текст фразы; пусто — речи не услышано.")
    confidence: Annotated[float, Field(ge=0, le=1)] | None = Field(
        description="Уверенность распознавания 0…1; null — сервис её не сообщает."
    )
    option_key: str | None = Field(
        description="Вариант ответа реплики бригады (reply_options), к которому сводится "
        "фраза; null — не расслышано или не сопоставлено, бригада переспрашивает. Ответ "
        "уходит событием brigade_reply с этим option_key и mode = voice."
    )
    loudness: VoiceReportLoudness | None = Field(
        default=None,
        description="Громкость речи во фразе: quiet — слишком тихо, ok — в норме, loud — "
        "слишком громко или с перегрузом. null — сервис распознавания громкость не меряет "
        "или речи не услышано.",
    )
    world_answers: bool = Field(
        default=False,
        description="Фраза без вопроса (delivery_id не передан), которую мир засчитает "
        "поправкой повтора адреса (correct_readback, HQ-024): бригада ответит репликой ветки "
        "мира («Понял, …, едем»), окно телефона своего ответа не даёт. Фраза всё равно уходит "
        "событием brigade_said.",
    )
