"""Что реплика бригады утверждает о мире: этап работы и службы на месте — по словам.

Связность мира держится не только на порядке докладов, но и на смысле фраз: «выезжаем» после
«бригада выехала», «разворачиваемся» после «прибыли», «поднимаемся» из дороги, «скорая
забрала» без звонка в 103 — всё это противоречия, которые слышит обучаемый (проверка 17.10).
Здесь одно правило на каждый смысл, без ИИ, по основам слов («ё» = «е»). Им пользуются
линтер сценариев (`app.seed.scenario_lint`, до каталога) и проверка прогона
(`app.tools.coherence.invariants`, по расшифровке).

Этапы бригады: `dispatch` (вводная, ещё не выехала) → `enroute` (в пути) → `onscene` (на
месте, работы) → `done` (итог). Фраза задаёт окно этапов, где её можно сказать
(`stage_window`); переход этапа — сам доклад плана (`stage_of_report`).

[ASSUMPTION] Основ слов хватает: фразы банка короткие и написаны по правилам банка
(`scripts/voices/bank/README.md`); новые слова этапов дописываются сюда вместе с фразами.
"""

import re
from dataclasses import dataclass

from evalcore.service_told import SERVICE_WORDS

STAGES = ("dispatch", "enroute", "onscene", "done")
RANK = {stage: index for index, stage in enumerate(STAGES)}
# Статус, который обосновывает доклад, → этап бригады после доклада.
STAGE_AFTER = {
    "accepted": "dispatch",
    "responding": "enroute",
    "arrived": "onscene",
    "working": "onscene",
    "completed": "done",
    "refused": "done",
}

_DEPARTING = re.compile(
    r"\b(?:выезжаем|выезжаю|выдвигаемся|выдвигаюсь|выходим из части|заводимся|завожу машину"
    r"|садимся в машину|уже в машине|собираемся)\b"
)
_ENROUTE = re.compile(
    r"\b(?:разворачива\w*|перестраива\w*|в пути|подъезжа\w*|сворачива\w*|по прибытии"
    r"|на подъезде|скоро буд\w*|будем через|буду через|минут\w* через|едем по\w*|еду туда"
    r"|едем туда|чуть не уехали|уже туда сворачивали|приедем)\b"
)
_ONSCENE = re.compile(
    r"\b(?:прибыли|прибыл|поднимаемся|поднимаюсь|заходим|захожу|уже внутри|нашли сами"
    r"|нашел сам|осматриваем|вскрываем)\b"
    r"|(?:^|[.!?,]\s*|\bмы\s+|\bя\s+|\bуже\s+|\bтеперь\s+)на месте\b(?!\s+(?:доложу|разбер))"
)
_DONE = re.compile(
    r"\b(?:возвращаемся|возвращается|работы завершены|работы закончили)\b"
    r"|\b(?:расчет|наряд|бригада|экипаж|мы)\s+свобод\w*"
)


def clean(text: str) -> str:
    return text.lower().replace("ё", "е")


@dataclass(frozen=True)
class StageWindow:
    """Этапы, на которых фразу можно сказать: [lo, hi]; почему — слово-признак."""

    lo: str
    hi: str
    reason: str | None

    def allows(self, stage: str) -> bool:
        return RANK[self.lo] <= RANK[stage] <= RANK[self.hi]


ANY = StageWindow("dispatch", "done", None)


def stage_window(text: str) -> StageWindow:
    """Окно этапов фразы по словам: «выезжаем» — до выезда, «разворачиваемся» — до прибытия,
    «поднимаемся» — на месте, «возвращаемся» — в итоге. Нет признаков — любой этап."""
    words = clean(text)
    lo, hi, reasons = 0, len(STAGES) - 1, []
    for pattern, low, high in (
        (_DEPARTING, "dispatch", "dispatch"),
        (_ENROUTE, "dispatch", "enroute"),
        (_ONSCENE, "onscene", "done"),
        (_DONE, "done", "done"),
    ):
        found = pattern.search(words)
        if found is None:
            continue
        lo, hi = max(lo, RANK[low]), min(hi, RANK[high])
        reasons.append(f"«{found.group(0).strip(' .,!?')}»")
    if not reasons:
        return ANY
    if lo > hi:
        # Фраза сама себе противоречит по этапам — проверке нечего сравнивать.
        return ANY
    return StageWindow(STAGES[lo], STAGES[hi], ", ".join(reasons))


def stage_conflict(text: str, stage: str, justifies: str | None = None) -> str | None:
    """Почему фразу нельзя сказать на этапе `stage`; None — можно.

    Доклад плана (`justifies` — статус, который он обосновывает) сам переводит этап: его
    слова сверяются и с этапом до доклада, и с этапом после («Прибыли» звучит из дороги).
    """
    window = stage_window(text)
    if window.allows(stage):
        return None
    if justifies is not None and window.allows(STAGE_AFTER.get(justifies, stage)):
        return None
    return f"{window.reason}: фраза этапа «{window.lo}–{window.hi}», а бригада — «{stage}»"


# --- Службы в репликах ------------------------------------------------------------------

# Номер службы → слова (как правило «служба вызвана», evalcore.service_told).
SERVICE_EXTS = {
    "103": "103",
    "101": "101",
    "102": "102",
    "104": "104",
    "105": "GKH",
    "106": "MOSLIFT",
}
_ABSENT = re.compile(
    r"\bнет\b|\bне\s|\bбез\b|\bтак и\b|\bгде\b|\?|\bвызыва\w*|\bвызовите\b|\bнужн\w*|\bсрочно\b"
    r"|\bсообщите\b|\bжд(?:ем|у|ать)\b|\bдождал\w*|\bпока\b|\bвстреча\w*|\bдо\s"
)
_PRESENT = re.compile(
    r"\b(?:забрал\w*|увез\w*|передан\w*|передали|приехал\w*|подъехал\w*|на месте|потушил\w*"
    r"|устранил\w*|вывел\w*|занимается|вскрывают|работают|опросил\w*|оцепил\w*|тушат|деблокир\w*"
    r"|извлек\w*|госпитализ\w*|вынесли|отвезли|сдали|увезла|уже вывел)\b"
)


_NOT_SERVICE = re.compile(r"\bучастков\w*\s+врач\w*")


@dataclass(frozen=True)
class Mention:
    """Служба в реплике: `present` — реплика утверждает, что служба на месте или отработала."""

    ext: str
    present: bool
    sentence: str


def service_mentions(text: str, own_service: str) -> list[Mention]:
    """Службы, о которых говорит реплика бригады (кроме своей), и на месте ли они.

    По предложениям: слово службы и признак присутствия («забрала», «потушили», «на месте») —
    служба на месте; отсутствие или просьба («нет», «так и не», «вызывайте», «ждём», вопрос) —
    не на месте.
    """
    own = {ext for ext, service in SERVICE_EXTS.items() if service == own_service}
    found: list[Mention] = []
    # «Участковый врач» — врач поликлиники, а не полиция и не скорая.
    words = _NOT_SERVICE.sub(" ", clean(text))
    for sentence in re.split(r"[.,!?;—]+\s*", words):
        if not sentence:
            continue
        for ext, pattern in SERVICE_WORDS.items():
            if ext in own or not pattern.search(sentence):
                continue
            present = bool(_PRESENT.search(sentence)) and not _ABSENT.search(sentence)
            found.append(Mention(ext, present, sentence))
    return found
