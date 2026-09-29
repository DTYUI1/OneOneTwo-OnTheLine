CRITERIA = (
    "reaction_time",
    "handling_time",
    "status_flow",
    "routing",
    "required_fields",
    "address",
    "call",
)
# Критерии комментария (28.09): грамотность и ключевые сведения. Веса необязательны:
# нет веса в settings — критерий не считается, поэтому занятия, созданные раньше,
# сохраняют прежние итоги. Новые настройки получают COMMENT_WEIGHTS.
COMMENT_CRITERIA = ("spelling", "comment_keywords")
COMMENT_WEIGHTS = {"spelling": 0.5, "comment_keywords": 1.0}
REACTION_NORMATIVE_S = 30
HANDLING_NORMATIVE_S = 180
CRITICAL_CAP = 0.5

# Универсальный автомат статусов карточки ДДС (дополнение C-01 от 24.09).
# Памятка ДДС, стр. 22–25: после «Принята» доступен перечень этапов, после «Не принята» —
# «Принята». Полной матрицы в памятке нет, поэтому этапы идут только вперёд, но могут
# пропускаться: какие этапы обязательны, задаёт эталон сценария, а не сервер.
# `redirected` — отдельное действие redirect из `rejected`, не status_change.
CARD_TRANSITIONS: dict[str, frozenset[str]] = {
    "received": frozenset({"accepted", "rejected"}),
    "rejected": frozenset({"accepted"}),
    "accepted": frozenset({"responding", "arrived", "working", "completed", "refused"}),
    "responding": frozenset({"arrived", "working", "completed", "refused"}),
    "arrived": frozenset({"working", "completed", "refused"}),
    "working": frozenset({"completed", "refused"}),
}
# Сохранение этих статусов закрывает карточку для редактирования (памятка, стр. 22).
CARD_TERMINAL_STATES = frozenset({"completed", "refused", "redirected"})
# Отказные статусы требуют содержательной причины в комментарии (памятка, стр. 21, 26).
CARD_REASON_REQUIRED = frozenset({"rejected", "refused"})
