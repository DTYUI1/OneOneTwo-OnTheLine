from collections.abc import Mapping
from typing import Any

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
# «Работа с бригадой» (DT-10, решение 08.10): реакция на события бригады — уточнение,
# просьба о другой службе, молчание, тревога. Вес необязателен, как у критериев комментария:
# нет веса в settings — критерий не считается (занятия до 08.10). Новые настройки получают
# BRIGADE_WEIGHTS; преподаватель меняет вес в настройках (принцип кейсодержателя: дефолт
# указать, но дать менять). Критичны тревога, после которой не вызвали скорую к бойцу
# (решение 15.10), и неисправленный повтор адреса (11.10).
BRIGADE_CRITERIA = ("brigade_work",)
BRIGADE_WEIGHTS = {"brigade_work": 1.0}
# Реакция после срока засчитывается наполовину: бригада дождалась, но дольше.
BRIGADE_LATE_SCORE = 0.5
# Детектор прокликивания (TC-10): статус меньше чем через столько секунд после открытия
# карточки или предыдущего статуса — «карточку не читали». Замечание без снижения балла:
# доклад бригады идёт не меньше 3 с (after_s в плане), прочитать карточку быстрее нельзя.
CLICKTHROUGH_S = 3
# Служба вызвана заранее, но бригаде не сказали (GP-28): сам звонок верный, замечание —
# бригада ждала и не знала, что служба едет. Небольшое снижение, не ошибка.
BRIGADE_UNTOLD_SCORE = 0.9
# Ветки «служба вызвана заранее» без своих последствий в плане действуют как `met`: служба
# приехала, мир в порядке (старые планы, файл без этих веток).
AHEAD_BRANCHES = ("already", "surprise")
# Вызванная служба едет к месту столько (`scenario_events.SERVICE_ARRIVAL`): к её приезду
# диспетчер сообщает бригаде, что служба едет (HQ-055, срок — от отбоя звонка в службу).
SERVICE_ARRIVAL_S = 20.0
REACTION_NORMATIVE_S = 30
HANDLING_NORMATIVE_S = 180
CRITICAL_CAP = 0.5
# Доклад службе вариантом ответа (DT-05, решение 02.10): засчитывается долей от такого же
# доклада голосом — выбрать готовый доклад проще, чем составить. Преподаватель меняет долю
# в настройках занятия (settings.report_choice_factor): 1 — без разницы, 0 — не засчитывать.
REPORT_CHOICE_FACTOR = 0.5
# Номер 112 в справочнике: только в этом звонке доклад называет карточку.
CARD_REPORT_EXT = "112"

# Телефон ДДС (рекомендации организаторов 16.10, п. 8; GP-09): абоненты, которых обучаемый
# набирает сам, — руководство, аварийная бригада и, если преподаватель включил, заявитель.
# Список задаёт преподаватель в settings.phone_contacts по ДДС, не больше 10 номеров; нет
# списка у ДДС — действует этот. Условные номера 400–999 не совпадают с номерами служб
# (1xx, 112) и бригад (2xx, 3xx).
PHONE_CONTACT_ROLES = ("head", "response_chief", "crew_chief", "crew_specialist", "caller")
PHONE_CONTACTS_MAX = 10
DEFAULT_PHONE_CONTACTS: tuple[dict[str, str], ...] = (
    {"role": "head", "name": "Руководитель организации", "number": "401"},
    {"role": "response_chief", "name": "Начальник отдела реагирования", "number": "402"},
    {"role": "crew_chief", "name": "Начальник аварийной бригады", "number": "403"},
    {"role": "crew_specialist", "name": "Специалист аварийной бригады", "number": "404"},
)


def phone_contacts(settings: Mapping[str, Any], service_id: str | None) -> list[dict[str, str]]:
    """Абоненты телефона ДДС `service_id` на занятии: список преподавателя или по умолчанию."""
    configured = settings.get("phone_contacts")
    if isinstance(configured, Mapping) and service_id in configured:
        items = configured[service_id]
        return [dict(item) for item in items] if isinstance(items, list) else []
    return [dict(item) for item in DEFAULT_PHONE_CONTACTS]


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
# Службы, которые не ставят «Не принята» и «Отказ от выполнения работ»: скорая вместо них
# закрывает карточку «Работы завершены: завершение работ без бригады» (памятка ДДС, стр. 23).
NO_REFUSAL_SERVICES = frozenset({"103"})

# Тип улицы не короче пяти букв допускает падежное окончание: «бульвар» → «бульвара»;
# сокращения остаются точными, иначе «пр-д» совпадёт с посторонним словом (`comment.py`).
_CASE_TYPE_MIN = 5

# Доклад службе и вводная бригаде голосом (`report.py`, HQ-024). Повод — половина значимых
# слов класса происшествия, но не больше VOICE_REASON_NEED_MAX: «Течь (прорыв трубы) в
# подвале» не пересказывают целиком, «прорвало трубу» — уже повод.
VOICE_REASON_NEED_MAX = 2
# Пересказ описания карточки: VOICE_RETELL_NEED разных слов не короче VOICE_RETELL_WORD_MIN
# букв («столкнулись автомобили»).
VOICE_RETELL_WORD_MIN = 5
VOICE_RETELL_NEED = 2
# Корень слова класса после приставки («задымление» → «дым»): корень не короче
# VOICE_ROOT_MIN букв, сравниваются первые VOICE_ROOT_PREFIX.
VOICE_ROOT_MIN = 5
VOICE_ROOT_PREFIX = 3
