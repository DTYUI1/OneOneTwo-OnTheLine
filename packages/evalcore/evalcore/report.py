"""Доклад службе голосом (DT-05, DT-11): распознанный текст → части доклада и его вид.

Порядок доклада — памятка ДДС, с. 32 (`criteria.REPORT_PARTS`): кто вы, адрес и повод,
карточка, что изменилось. Голос и варианты ответа оцениваются по одной шкале: текст сводится
к тому же виду, что и кнопка варианта (`call_hangup.report_choices`, `criteria.REPORT_GAPS`),
а прозвучавшие части уходят в `call_hangup.report_parts`. Засчитывается содержание, а не
факт звонка и не порядок слов.

Части ищутся тем же сравнением слов по начальной форме, что и ключевые сведения комментария
(`comment.py`):

- кто вы — слово должности или службы: «диспетчер», «дежурный», «оператор», «ДДС» (и
  «ДЭДЭЭС»), «старший»… или своя служба (`service_id` сценария) названием или номером:
  «служба 102», в том числе словами — «служба сто два» (распознавание пишет и «СТО-2») и по
  цифрам — «служба один ноль два»; чужой номер («служба 105» в звонке 102) — не представление,
  и название своей службы в просьбе тоже: «нужна скорая», «просим выслать газовую службу»;
  служба-подлежащее после «вызывает» и вступления «прошу принять» — представление: «Вас
  вызывает скорая помощь», «Прошу принять, скорая» (`_INTRODUCED`; это и не просьба для «что
  изменилось»); первое лицо («вызываем», «просим») и служба перед «нужна», «требуется» —
  просьба: «Прошу, скорая нужна»;
  ФИО по словам не проверить — его нет в сценарии [ASSUMPTION];
- адрес и повод — все значимые слова улицы эталона (без исправления опечаток; звание
  «Академика» можно опустить), номер дома там, где говорят дом (`comment.house_said`: «дом
  24», «в доме 24», «дом номер 24», «двадцать четвёртый дом», «Бескудниковский бульвар 24»;
  «квартира 24 дом 7» — дом 7) и повод: половина значимых слов класса происшествия карточки,
  но не больше VOICE_REASON_NEED_MAX (слово места «улица» не в счёт; «квартира», «подъезд»,
  «подвал», «дом» — одно слово и засчитываются только вместе с главным словом класса: их
  говорят и в адресе, `_reason_groups`; вместо слова класса — его синоним: «авария» за
  «ДТП», «пахнет» за «запах», `_INCIDENT_SYNONYMS`), корень слова класса («дым») или
  пересказ описания — два слова описания карточки, не места, и среди них смысловое слово
  происшествия («столкнулись два автомобиля»; «мужчина живёт один» — не повод); говорят
  своими словами, а не названием класса (журнал стенда 12.10, HQ-024). Повод под
  отрицанием — не повод: «задымления нет», «нет дыма»; «дымоход» — не «дым»;
- карточка — слово «карточка» или номер карточки цифрами; обязательна только в звонке
  в 112 (`criteria.required_parts`), в остальных звонках не спрашивается;
- что изменилось — слова изменения, направления сил или решения: «изменилась»,
  «требуется», «прислать», «направлен», «отправляю», «отказ», «решение», «стало хуже»,
  «газ уже перекрыли»…;
  просьба и нужда — вместе с тем, что нужно: «надо перекрыть», «нужна аварийка», «просим
  аварийную газовую», «вызываем газовую» (`_REQUESTS`; «прошу прощения», «надо уточнить»,
  «вас вызывает ДДС», «нужна помощь?» — нет); под отрицанием («не надо скорую»), «ничего
  нового», «без изменений» и слышимость («стало хуже слышно») — не изменение
  (`_change_text`); или обстановка с людьми:
  «зажат водитель», «жалуется на боль» — как в варианте ответа («Обстановка на месте: есть
  пострадавшие»). Слова, которые уже есть в классе происшествия («ДТП с пострадавшими»), и
  их синонимы («застрял» в «Застревание в лифте») обстановкой не считаются: это повод
  [ASSUMPTION].

Доклад меняет задачу (TC-05, `task_change` прозвучавшего доклада бригады): диспетчер звонит
сообщить, что обстановка изменилась и нужна другая служба. Новая обстановка — ключевые слова
перемены (`comment_keywords`: «пожар / горит / загорелось») — тогда и повод звонка, и то, что
изменилось: «Варшавское шоссе, 87, горит автомобиль» — адрес и повод и что изменилось, хотя в
классе карточки «ДТП без пострадавших» (стенд 17.10).

Перед сравнением из текста убираются запинки и слова-паразиты («э-э», «ну», «значит»),
«№» читается как «номер» (`plain_speech`), числа словами — цифрами (`spoken_numbers`).

Доклад складывается за звонок: на переспрос службы отвечают одной частью, поэтому клиент
присылает и прежние фразы звонка (`earlier`), а части ищутся в их сумме.

Вид доклада — первая недостающая часть по порядку памятки, всё есть — `full`. Вид `extra`
(лишние догадки) голосом не определяется: догадки по словам не отличить от сведений.
"""

import math
import re
from collections.abc import Sequence
from dataclasses import dataclass

from evalcore.address import _same_word, spoken_street_words, street_words
from evalcore.comment import (
    _DISPATCH,
    _REFUSAL,
    _STREET_TYPES,
    _VICTIMS,
    CommentKeywordsCriterion,
    Fact,
    _clean,
    _significant,
    _words,
)
from evalcore.criteria import PART_GAPS, REPORT_PARTS, required_parts
from evalcore.defaults import (
    VOICE_REASON_NEED_MAX,
    VOICE_RETELL_NEED,
    VOICE_RETELL_WORD_MIN,
    VOICE_ROOT_MIN,
    VOICE_ROOT_PREFIX,
)
from evalcore.models import Json, TextChecker
from evalcore.voice_reply import spoken_numbers as reply_numbers

# Решение по карточке словами доклада: «силы назначаются», «решение принимается».
_DECISION = ("назначить", "назначать", "направлять", "высылать", "принимать", "решение")
# Представиться: должность или служба. Начальные формы.
_WHO = (
    "диспетчер",
    "диспетчерская",
    "дежурный",
    "оператор",
    "ддс",
    "еддс",
    "старший",
    "начальник",
)
# Полные названия своей службы, а не основы прилагательных: «газовая труба», «пожарная
# лестница» и «аварийная ситуация» — обстановка, не представление. Без явного вступления
# сокращённое «газовая» / «пожарные» требует паузы, номера или конца фразы.
_SERVICE_NAMES = {
    "101": (
        r"пожарн[а-я]*\s+(?:охран[а-я]*|част[а-я]*|служб[а-я]*|бригад[а-я]*)",
        r"пожарно-спасательн(?:ая|ой|ую)\s+част(?:ь|и|ью)",
        r"пожарн(?:ая|ые|ый)(?=\s*(?:$|[,.!?:;]|\d))",
        r"спасател(?:ь|и|ей|я|ям|ями|ях)",
        r"мчс",
    ),
    "102": (
        r"(?:полици|милици)(?:я|и|ю|ей)",
        r"полицейск(?:ий|ие)(?=\s*(?:$|[,.!?:;]|\d))",
    ),
    "103": (
        r"скор(?:ая|ой|ую)\s+(?:медицинск[а-я]*\s+)?помощ[а-я]*",
        r"скорая(?=\s*(?:$|[,.!?:;]|\d))",
        r"медик(?:и|а|ов|ам|ами|ах)?",
    ),
    "104": (
        r"(?:аварийн[а-я]*\s+)?газов[а-я]*\s+(?:служб[а-я]*|бригад[а-я]*)",
        r"аварийн[а-я]*\s+(?:служб[а-я]*|бригад[а-я]*)",
        r"(?:аварийная\s+)?газовая(?=\s*(?:$|[,.!?:;]|\d))",
        r"(?:мосгаз|горгаз)(?:а|у|ом|е)?",
    ),
}
# В явном представлении распознавание может не поставить паузу перед адресом/карточкой.
# Допускаются только названия целиком, не любые слова с основами «газов», «пожарн».
# Родительный («звоню из пожарной / аварийной газовой») — лишь в явном представлении;
# без него _SERVICE_NAMES не принимает эти короткие формы за название службы.
_SHORT_SERVICE_NAMES = {
    "101": r"пожарн(?:ая|ые|ый|ой)",
    "102": r"полицейск(?:ий|ие)",
    "103": r"скор(?:ая|ой)",
    "104": r"(?:аварийная\s+)?газовая|(?:аварийной\s+)?газовой",
}
_SELF_INTRODUCTION = re.compile(r"(?<![а-я])(?:это|на\s+связи|звоню\s+из)\s+$")
# Короткое имя должно закончиться: пауза/номер или начало следующей части доклада.
# Список запрещённых предметов здесь принципиально неполон: «Это газовая утечка» и
# «Это газовая новая установка» — всё ещё именная группа, а не представление службы.
_SHORT_NAME_END = re.compile(r"\s*(?:$|[,.!?:;]|\d)")
_REPORT_PART_START = re.compile(
    r"\s+(?:(?:по\s+)?карточк(?:а|е)|(?:по\s+)?адрес(?:у)?"
    r"|работа(?:ю|ем)|докладыва(?:ю|ем)|сообща(?:ю|ем)"
    r"|(?:ситуация|обстановка)\s+изменилась)(?![а-я])"
)
# Приставки класса происшествия, после которых остаётся корень: «задымление» → «дым».
_INCIDENT_PREFIXES = ("за", "по", "на", "об", "от", "при")
# Длина корня и сравниваемой части — VOICE_ROOT_MIN и VOICE_ROOT_PREFIX (`defaults.py`).
# Служба с номером («служба 102», «служба номер 103») — тоже «кто вы»; Whisper иногда пишет
# должность латиницей («Dispatcher»). Номер словами сводится к цифрам (`spoken_service`).
# Номер диктуют и по цифре: «служба 1-0-2», «один ноль два» (→ «1 0 2»). «ДДС» Whisper пишет
# и буквами вслух: «ДЭДЭЭС», «дэ дэ эс», и латиницей: «DDS».
_WHO_PATTERN = re.compile(
    r"(?<![А-Яа-яЁё])д[эе]\s?д[эе]\s?[эе]с(?![А-Яа-яЁё])|\bdispatcher\b|\bdds\b", re.I
)
# Номер — своей службы (`service_id` сценария), как и название (`service_named`): «Служба
# 105» в звонке диспетчера 102 — не представление. У службы без номера (ЖКХ) — любой.
_SERVICE_NUMBER = re.compile(
    r"(?<![А-Яа-яЁё])служб[а-яё]*\s+(?:номер\s+)?(\d{2,3}|1[\s-]?0[\s-]?\d)(?!\d)", re.I
)
# Номер службы словами: «сто два», «СТО-2», «сто-2» → «102».
_SERVICE_UNITS = {
    "один": "1",
    "два": "2",
    "три": "3",
    "четыре": "4",
    "пять": "5",
    "шесть": "6",
    "семь": "7",
    "восемь": "8",
    "девять": "9",
}
_SPOKEN_SERVICE = re.compile(
    r"(?<![А-Яа-яЁё])сто[\s-]*(" + "|".join(_SERVICE_UNITS) + r"|[1-9])(?![А-Яа-яЁё\d])", re.I
)
# Просьба перед названием службы: «нужна скорая», «просим выслать аварийную газовую» — это
# просьба, а не представление (`service_named`). Начало слова и до двух слов между.
_ASKED_FOR = re.compile(
    r"(?<![а-я])(?:нужн|надо|необходим|прос|прош|высл|высыл|вызв|вызыв|присл|присыл|направ"
    r"|отправ|требу)[а-я]*[\s,.]+(?:[а-я-]+[\s,.]+){0,2}$"
)
# Представление, а не просьба (регресс HQ-024, лист решений 18.10): служба — подлежащее при
# «вызывает» (третье лицо, единственное число): «Вас вызывает скорая помощь», «Вызывает
# аварийная газовая служба», «Вызывает Мосгаз», — и после вступления «прошу принять»: «Прошу
# принять, скорая». Первое лицо («вызываем», «прошу», «просим выехать») и «вызывают» —
# просьба, даже если служба по форме в именительном: «Вызываем пожарные» (падеж спутало
# распознавание), «Прошу, скорая нужна». Между глаголом и службой нет слов просьбы и нужды,
# а сразу за службой — «нужна», «требуется»: «Прошу принять вызов, газовая служба
# требуется» — просьба. «Скорая, нужна полиция» (через запятую) — представление и просьба.
_INTRO_NOMINATIVE = (
    r"скорая|газовая|аварийная|аварийка|аварийный|газовый|пожарные|пожарная|пожарный"
    r"|пожарно-спасательная|пожарка|полиция|милиция|полицейские|полицейский"
    r"|спасатели|спасатель|медики|медик|служба|мосгаз|горгаз|мчс"
)
# Согласовано с полными названиями _SERVICE_NAMES: «часть требуется» / «охрана нужна»
# не должны превращать просьбу в представление при снятии глагола перед названием.
_INTRO_TAIL = r"помощь|служба|бригада|охрана|часть|газовая|аварийная|медицинская"
# Слова просьбы и нужды: между глаголом и службой и сразу за службой их быть не должно.
_NEED = (
    r"нужн|надо|необходим|требу|срочн|высл|высыл|присл|присыл|направ|отправ|выех|выезж"
    r"|вызв|вызыв|прос|прош|помоч|помоги"
)
_INTRODUCED = re.compile(
    r"(?<![а-яё])(?P<verb>вызывает|(?:прошу|просим)\s+принять)"
    rf"(?P<between>(?:[\s,.]+(?!(?:{_NEED}))[а-яё-]+){{0,2}}?[\s,.]+)"
    rf"(?:{_INTRO_NOMINATIVE})(?![а-яё])"
    rf"(?!(?:\s+(?:{_INTRO_TAIL})(?![а-яё]))*\s+(?:{_NEED}))",
    re.I,
)
# Обстановка с людьми на месте — часть «что изменилось», если этих слов нет в поводе.
_SCENE = (
    "зажать",
    "заблокировать",
    "заблокированный",
    "застрять",
    "сознание",
    "боль",
    "жаловаться",
)
# Направление сил несовершенным видом: «отправляю бригаду», «высылаем наряд».
_DISPATCH_NOW = ("направлять", "отправлять", "высылать", "выезжать")
# Изменение обстановки и что нужно: «ситуация изменилась», «требуется газовая служба».
_CHANGE = (
    # «Газ уже перекрыли», «перекрыли стояк» — обстановка изменилась (лист решений 18.10).
    "перекрыть",
    "изменить",
    "измениться",
    "изменение",
    "обстановка",
    "ситуация",
    "требоваться",
    "дополнительно",
    "ухудшиться",
    "ухудшение",
    "прислать",
    "присылать",
    # «стало хуже»: одно «хуже» — и «хуже слышно».
    "стать хуже",
)
# Просьба, «надо», «нужно» и «вызываем» — только вместе с тем, что нужно сделать или кого
# прислать: «надо перекрыть стояк», «нужна аварийка», «просим аварийную газовую», «вызываем
# газовую службу». Одно слово прозвучит и в вежливости или переспросе: «прошу прощения»,
# «надо уточнить», «вас вызывает ДДС».
_REQUEST = ("надо", "нужно", "нужный", "необходимо", "необходимый", "просить", "вызывать")
_REQUEST_WHAT = (
    "перекрыть",
    "отключить",
    "эвакуировать",
    "эвакуация",
    "вскрыть",
    "достать",
    "спасти",
    # Одно «помощь» — и в переспросе («Нужна помощь? Не слышу вас»): только «медицинская».
    "медицинский",
    "аварийный",
    "аварийка",
    "газовый",
    "газовщик",
    "скорый",
    "полиция",
    "пожарный",
    "спасатель",
    "мосгаз",
    "горгаз",
)
_REQUESTS = tuple(f"{request} {what}" for request in _REQUEST for what in _REQUEST_WHAT)
# Повод своими словами: слово класса происшествия (начальная форма) → как его говорят.
# Ключ — начальная форма или само слово класса карточки; вариант из нескольких слов
# засчитывается, если прозвучали все.
_INCIDENT_SYNONYMS = {
    "дтп": ("авария", "столкновение", "столкнуться", "врезаться"),
    "задымление": ("дым", "дымить", "задымить", "гарь", "пожар", "гореть"),
    "запах": ("пахнуть", "вонять", "утечка", "загазованность"),
    "застревание": ("застрять", "застревать"),
    # «Вода в подвале», «вода» — повод при течи (лист решений 18.10).
    "течь": ("протечка", "затопить", "затопление", "залить", "заливать", "топить", "вода"),
    "прорыв": ("прорвать", "порыв", "лопнуть", "вода"),
    "труба": ("трубопровод", "стояк"),
    "драка": ("драться", "подраться", "избить", "потасовка", "дебош"),
    "беспорядки": ("хулиганство", "хулиганить", "дебош"),
    "сердце": ("сердечный", "инфаркт"),
    "плохо": ("приступ", "недомогание"),
    "спасти": ("спасать", "достать", "доставать", "вытащить", "вытаскивать"),
    "животное": ("кот", "кошка", "котенок", "собака", "щенок", "питомец"),
    "заблокированный": ("зажать", "зажатый", "заблокировать", "застрять"),
    # Начальная форма «заблокированными» в словаре — глагол.
    "заблокировать": ("зажать", "зажатый", "застрять"),
}
# Слова места в классе происшествия (начальные формы): их говорят и в адресе («подъезд 2»),
# поэтому одни они повод не закрывают (`_reason_groups`).
_PLACE_WORDS = frozenset({"квартира", "подъезд", "подвал", "дом", "многоквартирный"})
# Слова адреса в описании карточки: «квартиры 115 на девятом этаже» — не пересказ повода.
_ADDRESS_PLACES = _PLACE_WORDS | {"этаж", "корпус", "строение", "кв", "корп", "стр"}
# Ключевые слова события, которых нет в классе карточки, — смысловое слово пересказа
# (`retold_incident`): «котёнок мяукает», «разбита голова», «жалуется на боль», «боль за
# грудиной».
_EVENT_WORDS = frozenset({"мяуканье", "мяукать", "разбить", "разбитый", "жаловаться", "грудина"})
# Слова, которые начинаются корнем класса, но не о происшествии: «дымоход» — не «дым».
_ROOT_FALSE = ("дымоход",)
# Отрицание (`_without_negated`): слово перед «нет» и после «не», «нет» — без знака
# препинания между ними. «Без» — нет: «без сознания» — обстановка.
_NEGATED_BEFORE = re.compile(r"[А-Яа-яЁё-]+\s+нет(?![А-Яа-яЁё])", re.I)
_NEGATED_AFTER = re.compile(r"(?<![А-Яа-яЁё-])(?:не|нет)\s+[А-Яа-яЁё-]+", re.I)
# Нет воды — не течь (`reason_said`): «без воды», «отключили (горячую) воду», «воду
# отключили», «вода не течёт», «воды нет». «Вода» — повод при течи (лист решений 18.10),
# но отсутствие воды — другое происшествие.
_NO_WATER = re.compile(
    r"(?<![а-яё])(?:без\s+(?:[а-яё]+\s+)?вод(?:а|ы|у|ой|е)"
    r"|отключ[а-яё]*\s+(?:[а-яё]+\s+)?вод(?:а|ы|у|ой|е)"
    r"|вод(?:а|ы|у|ой|е)\s+(?:[а-яё]+\s+)?(?:отключ[а-яё]*|нет|не\s+(?:теч|ид|бежит|поступа)[а-яё]*))"
    r"(?![а-яё])",
    re.I,
)
# «Ничего нового», «без изменений», «обстановка прежняя» — не «что изменилось».
_NO_CHANGE = re.compile(
    r"(?:(?:обстановк|ситуаци)[а-яё]*\s*(?:на\s+месте\s*)?[:,.—-]?\s*)?"
    r"(?:ничего\s+нового|ничего\s+не\s+измени[а-яё]*|без\s+изменени[а-яё]*"
    r"|изменений\s+нет|не\s+измени[а-яё]*|прежн[а-яё]*|по-прежнему)",
    re.I,
)
# Слышимость и связь — не обстановка: «стало хуже слышно», «плохо слышно», «связь хуже».
_HEARING = re.compile(
    r"(?:стал[а-яё]*\s+)?(?:хуже|плохо)\s+(?:слыш[а-яё]*|связ[а-яё]*)"
    r"|связ[а-яё]*\s+(?:стал[а-яё]*\s+)?хуже",
    re.I,
)
# Слова-паразиты и запинки, которые распознавание оставляет в тексте: между названием улицы
# и номером дома они мешают найти дом («Люблинская, э-э, сто»).
_FILLERS = re.compile(
    r"(?<![А-Яа-яЁё-])(?:э+(?:-э+)*|эм+|м{2,}|а-а+|ну|вот|короче|значит|типа)"
    r"(?![А-Яа-яЁё-])[,.…]?",
    re.I,
)
_REPEATED_PUNCT = re.compile(r"\s*([,.…])(?:\s*[,.…])+")
# Номер карточки цифрами; распознавание может разбить его пробелами: «10 000 001».
# «1 000 001», «1-000-001», «1.0.0.0.0.1» (Whisper ставит точки, когда диктуют по цифре).
_DIGIT_GAP = re.compile(r"(?<=\d)[\s.-](?=\d)")

# Распознавание пишет номер дома то цифрой, то словом («дом один»): слова — в цифры,
# иначе номер дома не сравнить с эталоном.
_NUMBERS = {
    word: str(index)
    for index, forms in enumerate(
        (
            "ноль нулевой",
            "один одна одно первый первая первое",
            "два две второй вторая второе",
            "три третий третья третье",
            "четыре четвёртый четвертый четвёртая четвертая",
            "пять пятый пятая",
            "шесть шестой шестая",
            "семь седьмой седьмая",
            "восемь восьмой восьмая",
            "девять девятый девятая",
            "десять десятый десятая",
        )
    )
    for word in forms.split()
}
_NUMBER_WORD = re.compile(r"(?<![А-Яа-яЁё])(" + "|".join(_NUMBERS) + r")(?![А-Яа-яЁё])", re.I)


def plain_speech(text: str) -> str:
    """Распознанная речь без запинок: «Люблинская, э-э, сто» → «Люблинская, сто»; «№» — «номер»."""
    text = _FILLERS.sub(" ", text.replace("№", " номер "))
    text = _REPEATED_PUNCT.sub(r"\1", text)
    return re.sub(r"[ \t]+", " ", text).strip()


def spoken_numbers(text: str, checker: TextChecker | None = None) -> str:
    """Числа словами — цифрами: «дом один» → «дом 1»; «сто два» → «102».

    С проверяющим — до 999 («дом двадцать четыре» → «дом 24», «девяносто восемь» → «98»);
    без него — только до десяти и номер службы.
    """
    text = _SPOKEN_SERVICE.sub(
        lambda match: "10" + _SERVICE_UNITS.get(match.group(1).casefold(), match.group(1)),
        text,
    )
    if checker is not None:
        text = reply_numbers(text, checker)
    return _NUMBER_WORD.sub(lambda match: _NUMBERS[match.group(1).casefold()], text)


# Однобуквенные предлоги, которые распознавание приклеивает к аббревиатуре: «ДТП с» → «ДТПС».
_GLUED_PREPOSITIONS = "свкуоСВКУО"


def unglued(text: str, facts: dict[str, list[Fact]]) -> str:
    """Отделить предлог от аббревиатуры из сведений доклада: «ДТПС пострадавшими» → «ДТП с…».

    Только аббревиатуры, которые ждём (все буквы заглавные), поэтому «МЧС» остаётся «МЧС».
    """
    abbreviations = {
        word
        for items in facts.values()
        for fact in items
        for group in fact.groups
        for word in group
        if len(word) > 1 and word.isupper()
    }
    for word in abbreviations:
        text = re.sub(
            rf"(?<![А-Яа-яЁё]){re.escape(word)}([{_GLUED_PREPOSITIONS}])(?![А-Яа-яЁё])",
            rf"{word} \1",
            text,
            flags=re.I,
        )
    return text


def recognition_hints(scenario: dict[str, Json]) -> tuple[str, ...]:
    """Слова, которые ждём в докладе, — подсказка распознаванию речи (hotwords Whisper).

    Улица карточки и улица эталона обе: если оператор ошибся в адресе, подсказка не
    тянет ни к одной из них. Плюс повод карточки и слова представления.
    """
    hints: list[str] = []
    card = scenario.get("card")
    card = card if isinstance(card, dict) else {}
    reference = scenario.get("reference")
    reference = reference if isinstance(reference, dict) else {}
    for address in (card.get("address"), reference.get("expected_address")):
        street = address.get("street") if isinstance(address, dict) else None
        if isinstance(street, str) and street.strip() and street.strip() not in hints:
            hints.append(street.strip())
    incident = card.get("incident_class") or scenario.get("incident_type_code")
    if isinstance(incident, str) and incident.strip():
        hints.append(incident.strip())
    hints += ["диспетчер", "служба", "карточка"]
    return tuple(hints)


def report_facts(scenario: dict[str, Json], checker: TextChecker) -> dict[str, list[Fact]]:
    """Что должно прозвучать в каждой части доклада по карточке и эталону сценария.

    Ключи — части памятки (`criteria.REPORT_PARTS`); часть прозвучала, если найдены все
    её сведения. Номер карточки проверяется отдельно (`card_number_said`).
    """
    card = scenario.get("card")
    card = card if isinstance(card, dict) else {}
    reference = scenario.get("reference")
    reference = reference if isinstance(reference, dict) else {}
    facts: dict[str, list[Fact]] = {part: [] for part in REPORT_PARTS}
    facts["who"].append(Fact("Кто вы: должность или служба", (_WHO,), 1))

    incident = card.get("incident_class") or scenario.get("incident_type_code")
    if isinstance(incident, str) and incident.strip():
        # Как в комментарии: «пострадавших» не закрывает суть («ДТП с пострадавшими»).
        victims = {lemma for word in _VICTIMS for lemma in checker.lemmas(word)}
        # «на улице» в «драка на улице» — место, а не повод: «Люблинская улица» не повод.
        words = [
            word
            for word in _significant(incident)
            if not checker.lemmas(word) & victims
            and _clean(word) not in _STREET_TYPES
            and not checker.lemmas(word) & _STREET_TYPES
        ] or _significant(incident)
        groups = _reason_groups(words, checker)
        if groups:
            facts["address"].append(
                Fact(
                    f"Повод: {incident}",
                    groups,
                    min(math.ceil(len(groups) / 2), VOICE_REASON_NEED_MAX),
                )
            )

    address = reference.get("expected_address") or card.get("address")
    if isinstance(address, dict):
        street = address.get("street")
        house = address.get("house")
        # Звание в названии можно не говорить: «Янгеля, 6» (`address.spoken_street_words`).
        named = set(spoken_street_words(street if isinstance(street, str) else ""))
        street_words = [
            word
            for word in _words(street if isinstance(street, str) else "")
            if _clean(word) not in _STREET_TYPES and _clean(word) in named
        ]
        house_text = house.strip() if isinstance(house, str) else ""
        building = address.get("building")
        if street_words or house_text:
            facts["address"].append(
                Fact(
                    f"Адрес: {street or ''} {house_text}".strip(),
                    tuple((word,) for word in street_words),
                    len(street_words),
                    exact=True,
                    house=house_text,
                    building=building.strip() if isinstance(building, str) else "",
                )
            )

    facts["card"].append(Fact("Карточка", (("карточка",),), 1))
    # Обстановка с людьми — без слов, которые уже есть в поводе («ДТП с заблокированными»).
    # И синонимы слов класса: «застрял» в «Застревание в лифте» — повод, а не перемена.
    reason = {
        lemma
        for word in _words(incident if isinstance(incident, str) else "")
        for form in (word, *_synonyms(word, checker))
        for lemma in checker.lemmas(form)
    }
    scene = tuple(word for word in _SCENE if not checker.lemmas(word) & reason)
    facts["change"].append(
        Fact(
            "Что изменилось: обстановка, силы или решение",
            ((*_CHANGE, *_REQUESTS, *_DISPATCH, *_DISPATCH_NOW, *_REFUSAL, *_DECISION, *scene),),
            1,
        )
    )
    return facts


def _reason_groups(words: list[str], checker: TextChecker) -> tuple[tuple[str, ...], ...]:
    """Группы слов повода: слово класса с синонимами; слова места — одной группой и только
    вместе с главным словом класса (первым не местом).

    Слова места говорят и в адресе («подъезд 2, квартира 5»), поэтому они никогда не
    единственное основание повода и не добирают второе совпадение к второстепенному слову:
    «Течь (прорыв трубы) в подвале» — «затопило подвал» (течь + место) повод, «подъезд 2,
    стояк» (труба + место) — нет; «Запах бытового газа в доме» — «дом 12, газ» не повод.
    Класс из одних слов места — повод не по словам класса (только пересказ описания).
    """
    places = tuple(word for word in words if checker.lemmas(word) & _PLACE_WORDS)
    groups = [(word, *_synonyms(word, checker)) for word in words if word not in places]
    if not groups:
        return ()
    if not places:
        return tuple(groups)
    with_head = tuple(f"{head} {place}" for head in groups[0] for place in places)
    return (*groups, with_head)


def _synonyms(word: str, checker: TextChecker) -> tuple[str, ...]:
    """Как говорят слово класса происшествия своими словами (`_INCIDENT_SYNONYMS`)."""
    keys = [_clean(word), *sorted(checker.lemmas(word))]
    return tuple(dict.fromkeys(item for key in keys for item in _INCIDENT_SYNONYMS.get(key, ())))


def reason_said(
    scenario: dict[str, Json],
    spoken: str,
    checker: TextChecker,
    lemmas: tuple[set[str], set[str]],
) -> bool:
    """Повод прозвучал: словами класса происшествия (и их синонимами), корнем слова класса
    («дым» — «задымление») или пересказом описания карточки. Одно правило для доклада службе
    и вводной бригаде. Класса и описания нет — повод не спрашивается."""
    exact, fuzzy = lemmas
    reason = [
        fact
        for fact in report_facts(scenario, checker)["address"]
        if fact.label.startswith("Повод")
    ]
    card = scenario.get("card")
    if not reason and not (isinstance(card, dict) and isinstance(card.get("description"), str)):
        return True
    # Отрицание повода — не повод: «задымления нет», «не горит» (`_without_negated`), и
    # «без воды», «отключили воду» — не течь (`_NO_WATER`).
    stripped = _without_negated(_NO_WATER.sub(" ", spoken))
    if stripped != spoken:
        spoken = stripped
        exact, fuzzy = CommentKeywordsCriterion._comment_lemmas(checker, spoken)
    retold = retold_incident(scenario, checker) or ()
    return (
        any(CommentKeywordsCriterion._found(checker, fact, spoken, exact, fuzzy) for fact in reason)
        or incident_root_said(scenario, spoken, checker)
        or (
            bool(retold)
            and all(
                CommentKeywordsCriterion._found(checker, fact, spoken, exact, fuzzy)
                for fact in retold
            )
        )
    )


def _without_introductions(text: str, *, between: bool) -> str:
    """Текст без глагола представления («Вас вызывает скорая», `_INTRODUCED`), с `between` —
    и без слов между ним и службой («Прошу принять, скорая»). Длина и позиции не меняются."""

    def blank(match: re.Match[str]) -> str:
        verb = match.group("verb")
        gap = match.group("between")
        kept = gap if not between else " " * len(gap)
        return " " * len(verb) + kept + match.group(0)[len(verb) + len(gap) :]

    return _INTRODUCED.sub(blank, text)


def _change_text(text: str) -> str:
    """Текст для части «что изменилось»: без «ничего нового» / «без изменений» (вместе со
    словом «обстановка» перед ними), без слышимости («стало хуже слышно»), без представления
    («Вас вызывает скорая», «Прошу принять, скорая» — не просьба и не «принять») и без слов
    под отрицанием: «Не надо скорую» — не просьба, «не изменилась» — не изменение."""
    text = _without_introductions(text, between=True)
    text = _NO_CHANGE.sub(" ", text)
    text = _HEARING.sub(" ", text)
    return _without_negated(text)


def _without_negated(text: str) -> str:
    """Текст без слов под отрицанием: «задымления нет», «нет дыма», «не горит».

    Слово перед «нет» и слово после «не», «нет» — если между ними нет знака
    препинания («Нет, горит квартира» — ответ, а не отрицание).
    """
    text = _NEGATED_BEFORE.sub(" ", text)
    return _NEGATED_AFTER.sub(" ", text)


def _event_lemmas(scenario: dict[str, Json], checker: TextChecker) -> set[str]:
    """Смысловые слова происшествия (начальные формы): слова класса карточки без слов места,
    их синонимы (`_INCIDENT_SYNONYMS`) и ключевые слова события (`_EVENT_WORDS`)."""
    card = scenario.get("card")
    incident = card.get("incident_class") if isinstance(card, dict) else None
    words = _significant(incident) if isinstance(incident, str) else []
    lemmas: set[str] = set(_EVENT_WORDS)
    for word in words:
        forms = {_clean(word)} | checker.lemmas(word)
        if forms & (_ADDRESS_PLACES | _STREET_TYPES):
            continue
        lemmas |= forms
        for synonym in _synonyms(word, checker):
            lemmas |= {_clean(synonym)} | checker.lemmas(synonym)
    return lemmas


def retold_incident(scenario: dict[str, Json], checker: TextChecker) -> tuple[Fact, Fact] | None:
    """Повод своими словами: два значимых слова описания карточки («столкнулись автомобили»),
    из них хотя бы одно — смысловое слово происшествия (`_event_lemmas`: слово класса, его
    синоним, ключевое слово события). Иначе любые два слова описания давали повод: «мужчина
    живёт один», «жильцы открыли окна» — не повод (критик HQ-024, круг 3).

    Слова места (`_PLACE_WORDS`, «этаж») и адрес из описания не в счёт — их говорят в адресе;
    формы одного слова («квартиры», «в квартире») — одно слово. Возвращает пересказ и его
    смысловые слова: `reason_said` требует, чтобы прозвучали оба сведения.
    """
    card = scenario.get("card")
    description = card.get("description") if isinstance(card, dict) else None
    if not isinstance(description, str):
        return None
    # Адрес в описании — не повод: «Москва, Дубнинская улица» засчитывается адресом.
    address = card.get("address") if isinstance(card, dict) else None
    place = {
        _clean(word)
        for value in (address.values() if isinstance(address, dict) else ())
        if isinstance(value, str)
        for word in _words(value)
    } | _STREET_TYPES
    words: dict[str, str] = {}
    for word in _significant(description):
        lemmas = checker.lemmas(word)
        if len(word) < VOICE_RETELL_WORD_MIN or _clean(word) in place or lemmas & _ADDRESS_PLACES:
            continue
        words.setdefault(min(lemmas, default=_clean(word)), word)
    event = _event_lemmas(scenario, checker)
    meaning = tuple(
        word for word in words.values() if ({_clean(word)} | checker.lemmas(word)) & event
    )
    if len(words) < VOICE_RETELL_NEED or not meaning:
        return None
    return Fact(
        "Повод своими словами", tuple((word,) for word in words.values()), VOICE_RETELL_NEED
    ), Fact("Смысловое слово происшествия", (meaning,), 1)


def incident_root_said(scenario: dict[str, Json], text: str, checker: TextChecker) -> bool:
    """Повод назван корнем слова класса: «дым» для «задымление: квартира», «горит» — «загорание».

    Слова места не дают корня («подвал» → «два…»), и слова адреса не корень: «строение 2» —
    не «застревание».
    """
    card = scenario.get("card")
    incident = card.get("incident_class") if isinstance(card, dict) else None
    if not isinstance(incident, str):
        return False
    said = [
        _clean(word)
        for word in _words(text)
        if not ({_clean(word)} | checker.lemmas(word)) & _ADDRESS_PLACES
        and not _clean(word).startswith(_ROOT_FALSE)
    ]
    for word in _significant(incident):
        if checker.lemmas(word) & _ADDRESS_PLACES:
            continue
        clean = _clean(word)
        for prefix in _INCIDENT_PREFIXES:
            root = clean[len(prefix) :]
            if clean.startswith(prefix) and len(root) >= VOICE_ROOT_MIN:
                head = root[:VOICE_ROOT_PREFIX]
                if any(len(w) >= VOICE_ROOT_PREFIX and w.startswith(head) for w in said):
                    return True
    return False


def _short_service_ended(scenario: dict[str, Json], after: str) -> bool:
    """После короткого имени — граница или начало доклада, а не произвольное существительное."""
    if _SHORT_NAME_END.match(after) or _REPORT_PART_START.match(after):
        return True
    # Без пунктуации улица может идти сразу: «Это газовая Дубнинская улица».
    # Проверяем именно начало хвоста, иначе «утечка на Дубнинской» дала бы «кто вы».
    said = _words(after)
    if said and said[0] in {"на", "по"}:
        said = said[1:]
    if said and any(_same_word(said[0], kind) for kind in _STREET_TYPES):
        said = said[1:]
    for section, key in (("card", "address"), ("reference", "expected_address")):
        source = scenario.get(section)
        address = source.get(key) if isinstance(source, dict) else None
        street = address.get("street") if isinstance(address, dict) else None
        if isinstance(street, str):
            # Для границы достаточно узнаваемого названия, в том числе в другом падеже.
            # Правильность самого адреса по-прежнему отдельно проверяет часть «адрес».
            for words in (street_words(street), spoken_street_words(street)):
                if (
                    words
                    and len(said) >= len(words)
                    and all(
                        _same_word(left, right) for left, right in zip(said, words, strict=False)
                    )
                ):
                    return True
    return False


def service_named(scenario: dict[str, Json], text: str) -> bool:
    """Службу назвали по имени: «скорая», «пожарные» — по номеру службы сценария.

    Прилагательное при слове происшествия — не название: «газовая труба», «пожарная лестница».
    Полное название или отдельное сокращённое имя сверяется целиком (`_SERVICE_NAMES`).
    Короткое имя без паузы допустимо только после явного вступления (`_SELF_INTRODUCTION`
    или `_INTRODUCED`), если дальше начинается следующая часть (`_short_service_ended`).
    Название в просьбе — не представление: «нужна скорая», «просим выслать газовую службу»
    (`_ASKED_FOR`: просьба за одно-два слова до названия). Служба-подлежащее после «вызывает»,
    «прошу» — представление: «Вас вызывает скорая помощь», «Прошу принять, скорая»
    (`_INTRODUCED`).
    """
    service = scenario.get("service_id")
    names = _SERVICE_NAMES.get(service, ()) if isinstance(service, str) else ()
    clean = _clean(text)
    lowered = _without_introductions(clean, between=False)
    if any(
        not _ASKED_FOR.search(lowered[: match.start()])
        for name in names
        for match in re.finditer(rf"(?<![а-я])(?:{name})(?![а-я])", lowered)
    ):
        return True
    short = _SHORT_SERVICE_NAMES.get(service) if isinstance(service, str) else None
    if short is None:
        return False
    introduced = {match.end("between") for match in _INTRODUCED.finditer(clean)}
    return any(
        (match.start() in introduced or _SELF_INTRODUCTION.search(clean[: match.start()]))
        and not _ASKED_FOR.search(lowered[: match.start()])
        and _short_service_ended(scenario, clean[match.end() :])
        and not re.match(rf"\s+(?:{_NEED})", clean[match.end() :])
        for match in re.finditer(rf"(?<![а-я])(?:{short})(?![а-я])", clean)
    )


def service_number_said(scenario: dict[str, Json], text: str) -> bool:
    """Представились своей службой с номером: «служба 102», «служба 1-0-2» (`_SERVICE_NUMBER`)."""
    service = scenario.get("service_id")
    own = service if isinstance(service, str) and service.isdigit() else None
    return any(
        own is None or re.sub(r"\D", "", match.group(1)) == own
        for match in _SERVICE_NUMBER.finditer(text)
    )


def card_number_said(scenario: dict[str, Json], text: str) -> bool:
    """Номер карточки сказан цифрами (пробелы и дефисы между цифрами не мешают)."""
    card = scenario.get("card")
    number = card.get("number") if isinstance(card, dict) else None
    if not isinstance(number, str) or not number.strip():
        return False
    joined = _DIGIT_GAP.sub("", text)
    return re.search(rf"(?<!\d){re.escape(number.strip())}(?!\d)", joined) is not None


def change_facts(changes: Sequence[Json]) -> list[Fact]:
    """Новая обстановка из перемен задачи (TC-05): ключевые слова `task_change.comment_keywords`.

    «пожар / пожарные / горит»: варианты через косую черту, достаточно одного. Номер службы
    («112») обстановкой не считается: куда звонят — не что случилось.
    """
    facts: list[Fact] = []
    for change in changes:
        keywords = change.get("comment_keywords") if isinstance(change, dict) else None
        for item in keywords if isinstance(keywords, list) else []:
            if not isinstance(item, str):
                continue
            variants = tuple(
                variant.strip()
                for variant in item.split("/")
                if variant.strip() and not variant.strip().isdigit()
            )
            if variants:
                facts.append(Fact(f"Обстановка изменилась: {item.strip()}", (variants,), 1))
    return facts


# Зачем звонят службе, которую попросила бригада (`request_service`): её обстановка — это и
# повод, и «что изменилось». «Горит квартира» в звонке 101 после «вызывайте пожарных» —
# полный доклад (проверка 17.10: «говорю что надо — не распознаёт»). Варианты через косую
# черту, как в `comment_keywords`.
SERVICE_NEEDS: dict[str, str] = {
    "101": "пожар / пожарные / горит / гореть / огонь / дым / задымление / загорелось / "
    "спасатели / зажало / заклинило / вскрыть / загазованность",
    "102": "полиция / наряд / агрессивный / драка / избили / криминальная / оцепить / угрожает",
    "103": "скорая / пострадавший / пострадавшие / ранен / травма / кровь / сознание / плохо / "
    "задыхается / давление / сердце",
    "104": "газ / мосгаз / перекрыть / утечка / стояк",
}


def requested_change(phone_exts: Sequence[object]) -> Json | None:
    """Перемена задачи из просьбы бригады вызвать службу: ключевые слова этой службы.

    `phone_exts` — куда звонить (`expect.phone_exts` события): 112 — общий номер, обстановка
    берётся по службе, которую просили.
    """
    for ext in phone_exts:
        words = SERVICE_NEEDS.get(str(ext))
        if words:
            return {"comment_keywords": [words]}
    return None


@dataclass(frozen=True)
class ReportCheck:
    """Что прозвучало в докладе: части памятки и чего не хватило в адресе и поводе.

    address_gap — `place` (нет адреса: улицы или дома), `reason` (адрес есть, нет повода);
    `None` — часть «адрес и повод» прозвучала. Служба переспрашивает одним вопросом именно то,
    чего не хватило.
    """

    parts: tuple[str, ...]
    address_gap: str | None


def voice_report_check(
    scenario: dict[str, Json],
    text: str,
    checker: TextChecker,
    changes: Sequence[Json] = (),
) -> ReportCheck:
    """Какие части памятки прозвучали в распознанном тексте, в порядке памятки.

    Формула: часть прозвучала, если каждое её сведение найдено — в тексте не меньше `need`
    групп слов сведения (сравнение по начальной форме; адрес — без исправления опечаток и с
    номером дома; повод — классом происшествия или пересказом описания, `retold_incident`).
    Карточка — ещё и по номеру карточки цифрами. Предлог, приклеенный распознаванием к
    ожидаемой аббревиатуре, отделяется (`unglued`). `changes` — перемены задачи, прозвучавшие
    на карточке (TC-05): их обстановка засчитывается и поводом, и тем, что изменилось.
    """
    facts = report_facts(scenario, checker)
    spoken = unglued(spoken_numbers(plain_speech(text), checker), facts)
    exact, fuzzy = CommentKeywordsCriterion._comment_lemmas(checker, spoken)

    changed = any(
        CommentKeywordsCriterion._found(checker, fact, spoken, exact, fuzzy)
        for fact in change_facts(changes)
    )

    def fact_found(fact: Fact) -> bool:
        # Повод можно назвать классом происшествия, пересказать описание карточки или
        # назвать новую обстановку, ради которой звонят (TC-05); отрицание повода
        # («задымления нет») не в счёт — всё это в `reason_said`.
        if fact.label.startswith("Повод"):
            return changed or reason_said(scenario, spoken, checker, (exact, fuzzy))
        return CommentKeywordsCriterion._found(checker, fact, spoken, exact, fuzzy)

    def found(part: str) -> bool:
        if part == "card" and card_number_said(scenario, spoken):
            return True
        if part == "who" and (
            _WHO_PATTERN.search(spoken)
            or service_number_said(scenario, spoken)
            or service_named(scenario, spoken)
        ):
            return True
        if part == "change":
            if changed:
                return True
            # Отрицание, «ничего нового» и слышимость — не изменение (`_change_text`).
            told = _change_text(spoken)
            pools = CommentKeywordsCriterion._comment_lemmas(checker, told)
            return all(
                CommentKeywordsCriterion._found(checker, fact, told, *pools) for fact in facts[part]
            )
        return all(fact_found(fact) for fact in facts[part])

    parts = tuple(part for part in REPORT_PARTS if found(part))
    gap: str | None = None
    if "address" not in parts:
        place = [fact for fact in facts["address"] if not fact.label.startswith("Повод")]
        gap = "reason" if place and all(fact_found(fact) for fact in place) else "place"
    return ReportCheck(parts, gap)


def voice_report_parts(
    scenario: dict[str, Json],
    text: str,
    checker: TextChecker,
    changes: Sequence[Json] = (),
) -> tuple[str, ...]:
    """Части памятки, прозвучавшие в тексте: `voice_report_check(...).parts`."""
    return voice_report_check(scenario, text, checker, changes).parts


def report_choice(parts: tuple[str, ...], phone_ext: object = None) -> str:
    """Вид доклада по прозвучавшим частям: `full` или первая недостающая обязательная часть.

    Карточка обязательна только в звонке в 112 (`criteria.required_parts`).
    """
    for part in required_parts(phone_ext):
        if part not in parts:
            return PART_GAPS[part]
    return "full"


def voice_report_choice(scenario: dict[str, Json], text: str, checker: TextChecker) -> str:
    """Вид доклада по распознанному тексту: `report_choice(voice_report_parts(...))`."""
    return report_choice(voice_report_parts(scenario, text, checker))
