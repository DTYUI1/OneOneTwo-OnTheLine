"""Реплики заявителей «Оператор 112» для озвучки (этапы 2–3, docs/operator_112_review/PLAN.md).

Ключи реплик — те же, что возвращает заявитель на сервере (`voice_lines` в
apps/api/app/operator/caller.py); совпадение ключей и текстов с озвученными файлами проверяет
test_operator_caller.py. Здесь своя копия раскладки: синтез идёт в контейнере без кода API.
"""

from __future__ import annotations

from typing import Any

# Голос Piper и его обработка по персонажу. Детский голос — женский, выше на треть;
# пожилой — ниже и медленнее, с лёгкой дрожью. Сдвиг тона — ffmpeg (asetrate).
PROFILES: dict[str, dict[str, Any]] = {
    "young_woman": {"voice": "irina", "pitch": 1.0, "length": 1.0, "tremble": False},
    "adult": {"voice": "ruslan", "pitch": 1.0, "length": 1.0, "tremble": False},
    "elderly": {"voice": "irina", "pitch": 0.9, "length": 1.18, "tremble": True},
    "child": {"voice": "irina", "pitch": 1.28, "length": 0.95, "tremble": False},
}

# Паника звучит быстрее и выше, истерика — ещё быстрее, выше и громче (план, этап 2).
STYLES: dict[str, dict[str, float]] = {
    "calm": {"length": 1.0, "noise": 0.667, "noise_w": 0.8, "pitch": 1.0, "gain": 0},
    "panic": {"length": 0.88, "noise": 0.8, "noise_w": 1.0, "pitch": 1.04, "gain": 1},
    "hyst": {"length": 0.8, "noise": 0.85, "noise_w": 1.1, "pitch": 1.08, "gain": 3},
}

REACTION_STYLES = {
    "calming": "panic",
    "calmed": "calm",
    "order": "hyst",
    "repeat": "panic",
    "not_understood": "panic",
    "irrelevant": "panic",
    "hold": "calm",
}

# Этап 3: ответы на повтор адреса. Поправка улицы — резко («Нет-нет, не так!»), недовольное
# «Я же говорю…» и ненадёжное «да» в панике — быстрее; согласие и поправка номера — спокойно.
CONFIRM_STYLES = {
    "ok": "calm",
    "wrong_street": "panic",
    "wrong_details": "calm",
    "empty": "panic",
    "panic": "panic",
}


def opening_style(start_panic: int) -> str:
    return "hyst" if start_panic >= 3 else "panic" if start_panic == 2 else "calm"


def lines_for(scenario: dict[str, Any]) -> list[dict[str, str]]:
    """Реплики сценария: ключ, текст и стиль — в том же порядке ключей, что у сервера."""
    rows: list[dict[str, str]] = []

    def add(line: str, text: str, style: str) -> None:
        rows.append({"line": line, "text": text, "style": style})

    if scenario.get("opening"):
        add("opening", scenario["opening"], opening_style(scenario.get("start_panic", 1)))
    for key, answer in scenario["answers"].items():
        add(f"{key}.calm", answer["calm"], "calm")
        add(f"{key}.panic", answer["panic"], "panic")
    confirmation = scenario.get("address_confirmation")
    if confirmation:
        for name, style in CONFIRM_STYLES.items():
            add(f"confirm.{name}", confirmation[name], style)
    # Лишний вопрос шага злит заявителя — ответ раздражённый, быстрее.
    for item in scenario.get("distractors", []):
        add(f"distractor.{item['key']}", item["reply"], "panic")
    reactions = scenario.get("reactions")
    if reactions:
        for index, text in enumerate(reactions["hysteria"]):
            add(f"hysteria.{index}", text, "hyst")
        for name, style in REACTION_STYLES.items():
            add(name, reactions[name], style)
        for index, text in enumerate(reactions["pause"]):
            add(f"pause.{index}", text, "panic" if index == 0 else "hyst")
    for item in scenario.get("advice", []):
        add(f"advice.{item['key']}", item["reply"], "calm")
    escalation = scenario.get("escalation")
    if escalation:
        add("escalation", escalation["text"], "panic")
    return rows


# Фон в трубке — синтез ffmpeg (lavfi), без сторонних записей: 16 с, чтобы все периоды
# (писк датчика 4 с, тиканье 1 с, машины 8 с) укладывались в петлю без стыка.
BACKGROUND_SECONDS = 16
BACKGROUNDS: dict[str, str] = {
    # Подъезд и приглушённый писк датчика дыма за дверью: три писка каждые 4 с.
    "stairwell_alarm": (
        "anoisesrc=color=brown:amplitude=0.035:duration={d},lowpass=f=900[room];"
        "sine=f=3100:duration={d},"
        "volume='if(lt(mod(t,4),0.96)*lt(mod(mod(t,4),0.32),0.18),0.05,0)':eval=frame,"
        "lowpass=f=2600[alarm];"
        "[room][alarm]amix=inputs=2:normalize=0"
    ),
    # Улица: шум потока, машины проезжают волной раз в 8 с.
    "street": (
        "anoisesrc=color=pink:amplitude=0.06:duration={d},"
        "bandpass=f=600:width_type=h:w=1200,tremolo=f=0.125:d=0.6"
    ),
    # Квартира: тихо, тикают часы.
    "apartment": (
        "anoisesrc=color=brown:amplitude=0.012:duration={d},lowpass=f=700[room];"
        "sine=f=1800:duration={d},"
        "volume='if(lt(mod(t,1),0.012),0.05,0)':eval=frame[tick];"
        "[room][tick]amix=inputs=2:normalize=0"
    ),
    # Лифтовая шахта: гул и тесная кабина с эхом.
    "lift": (
        "sine=f=100:duration={d},volume=0.03[hum];"
        "anoisesrc=color=brown:amplitude=0.025:duration={d},lowpass=f=450[shaft];"
        "[hum][shaft]amix=inputs=2:normalize=0,aecho=0.6:0.4:35:0.3"
    ),
}
