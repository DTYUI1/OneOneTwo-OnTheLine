"""Громкость голосового доклада: не слишком тихо и не слишком громко.

Сервис распознавания меряет фразу (deploy/stt/server.py, `loudness`): уровень речевых
кадров в дБ полной шкалы и долю отсчётов у края шкалы. Браузер пишет доклад без
автоусиления (apps/web phraseRecorder), иначе тихое и громкое выровнялись бы.

Пороги — допущение для ноутбучного микрофона на расстоянии вытянутой руки
[ASSUMPTION: проверить на стенде на нескольких микрофонах]:
- тихо — речь ниже −40 дБ: так звучит шёпот или микрофон далеко, на том конце переспросят;
- громко — речь выше −10 дБ или больше 0,5 % отсчётов в перегрузе: крик и хрип в трубке.
"""

from typing import Literal

Loudness = Literal["quiet", "ok", "loud"]

QUIET_BELOW_DBFS = -40.0
LOUD_ABOVE_DBFS = -10.0
CLIPPED_SHARE_LOUD = 0.005

LOUDNESS_TEXT: dict[str, str] = {
    "quiet": "слишком тихо",
    "ok": "громкость в норме",
    "loud": "слишком громко",
}


def loudness_verdict(speech_dbfs: float, clipped_share: float) -> Loudness:
    """Тихо, в норме или громко по уровню речи и доле перегруза."""
    if clipped_share > CLIPPED_SHARE_LOUD or speech_dbfs > LOUD_ABOVE_DBFS:
        return "loud"
    if speech_dbfs < QUIET_BELOW_DBFS:
        return "quiet"
    return "ok"
