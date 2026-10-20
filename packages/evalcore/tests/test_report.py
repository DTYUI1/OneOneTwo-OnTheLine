"""Доклад службе голосом (DT-05, DT-11): части памятки ДДС, с. 32, и вид доклада по ним."""

import json
from pathlib import Path

import pytest
from evalcore.criteria import REPORT_PARTS, report_parts_of, required_parts
from evalcore.report import (
    SERVICE_NEEDS,
    card_number_said,
    recognition_hints,
    report_choice,
    report_facts,
    requested_change,
    service_named,
    spoken_numbers,
    unglued,
    voice_report_check,
    voice_report_choice,
    voice_report_parts,
)

from .test_comment import FakeChecker as CommentChecker

GOLDEN = Path(__file__).parents[3] / "data" / "golden_scenarios" / "case-01.json"
# Карточка case-01: «ДТП с пострадавшими», Дубнинская улица, дом 1, есть пострадавшие.
SCENARIO = json.loads(GOLDEN.read_text(encoding="utf-8"))["scenario"]


class FakeChecker(CommentChecker):
    """Словарь комментария плюс формы, которые встречаются в устном докладе."""

    SPOKEN = {
        "пострадавшие": "пострадавший",
        "направлены": "направить",
        "экипаж": "экипаж",
        "карточке": "карточка",
        "карточку": "карточка",
        "изменилась": "измениться",
        "требуется": "требоваться",
        "дежурный": "дежурный",
        "отправляю": "отправлять",
        "зажат": "зажать",
        "столкнулись": "столкнуться",
    }

    def lemmas(self, word: str) -> frozenset[str]:
        clean = word.casefold().replace("ё", "е")
        return frozenset({self.SPOKEN[clean]}) if clean in self.SPOKEN else super().lemmas(word)


def choice(text: str, scenario: dict = SCENARIO) -> str:
    return voice_report_choice(scenario, text, FakeChecker())


def parts(text: str, scenario: dict = SCENARIO) -> tuple[str, ...]:
    return voice_report_parts(scenario, text, FakeChecker())


# Полный доклад по памятке: кто вы, адрес и повод, карточка, что изменилось.
FULL = (
    "Диспетчер ДДС Иванов. Дубнинская улица, дом один, ДТП с пострадавшими. "
    "Работаем по карточке 10000001. Ситуация изменилась, требуется скорая."
)


def test_full_report_by_meaning_not_by_wording():
    assert parts(FULL) == ("who", "address", "card", "change")
    assert choice(FULL) == "full"
    # Другой порядок и другие слова — то же содержание; карточка — номером.
    assert choice("Дубнинская 1, ДТП. По 10 000 001 направлен экипаж. Дежурный Петров") == "full"


@pytest.mark.parametrize(
    ("text", "kind", "said"),
    [
        # Не представился — самая частая ошибка: сразу к делу.
        (
            "Дубнинская улица, дом 1, ДТП. Работаем по карточке 10000001. "
            "Ситуация изменилась, требуется скорая.",
            "no_who",
            ("address", "card", "change"),
        ),
        # Понадеялся на номер карточки: ни адреса, ни повода.
        (
            "Диспетчер ДДС Иванов, работаем по карточке 10000001. Ситуация изменилась.",
            "no_address",
            ("who", "card", "change"),
        ),
        # Улица без дома — адрес неполный.
        (
            "Диспетчер ДДС, ДТП на Дубнинской улице, по карточке 10000001, требуется скорая.",
            "no_address",
            ("who", "card", "change"),
        ),
        # Адрес без повода — тоже неполная часть.
        (
            "Диспетчер ДДС, Дубнинская улица, дом 1, по карточке 10000001, требуется скорая.",
            "no_address",
            ("who", "card", "change"),
        ),
        # Похожая улица — не та: адрес сравнивается без исправления опечаток.
        (
            "Диспетчер ДДС, ДТП на Дубининской улице, дом 1, карточка 10000001, требуется скорая.",
            "no_address",
            ("who", "card", "change"),
        ),
        (
            "Диспетчер ДДС Иванов. Дубнинская улица, дом 1, ДТП. Ситуация изменилась.",
            "no_card",
            ("who", "address", "change"),
        ),
        # Пострадавшие в поводе — не изменение обстановки.
        (
            "Диспетчер ДДС Иванов. Дубнинская улица, дом 1, ДТП с пострадавшими. "
            "Работаем по карточке 10000001.",
            "no_change",
            ("who", "address", "card"),
        ),
        ("", "no_who", ()),
    ],
)
def test_incomplete_report_names_first_missing_part(text, kind, said):
    assert parts(text) == said
    assert choice(text) == kind


def test_several_parts_missing_are_all_reported():
    said = parts("ДТП на Дубнинской улице, дом 1")
    assert said == ("address",)
    assert report_choice(said) == "no_who"


def test_card_number_digits_only_as_whole_number():
    assert card_number_said(SCENARIO, "карточка 10 000 001")
    assert card_number_said(SCENARIO, "номер 10000001.")
    assert not card_number_said(SCENARIO, "номер 100000012")
    assert not card_number_said({**SCENARIO, "card": {}}, "10000001")


def test_facts_follow_card_and_reference():
    facts = report_facts(SCENARIO, FakeChecker())
    assert list(facts) == list(REPORT_PARTS)
    (address,) = (fact for fact in facts["address"] if fact.exact)
    assert address.house == "1"
    assert len(facts["address"]) == 2


def test_choice_and_parts_agree_both_ways():
    for part in REPORT_PARTS:
        said = tuple(other for other in REPORT_PARTS if other != part)
        assert report_parts_of(report_choice(said)) == said
    assert report_choice(tuple(REPORT_PARTS)) == "full"
    assert report_parts_of("full") == tuple(REPORT_PARTS)
    assert report_parts_of("extra") == tuple(REPORT_PARTS)
    # Виды до порядка памятки: суть — часть «адрес и повод», силы — «что изменилось».
    assert "address" not in report_parts_of("no_incident")
    assert "change" not in report_parts_of("no_victims")


def test_spoken_numbers_become_digits():
    assert spoken_numbers("дом один, корпус Два") == "дом 1, корпус 2"
    # Внутри слова число не трогаем.
    assert spoken_numbers("одинокий") == "одинокий"


def test_preposition_glued_to_expected_abbreviation():
    # Whisper small слышит «ДТП с пострадавшими» как «ДТПС пострадавшими» (DT-12, стенд).
    assert choice(FULL.replace("ДТП с", "ДТПС")) == "full"
    facts = report_facts(SCENARIO, FakeChecker())
    assert unglued("ДТПс пострадавшими", facts) == "ДТП с пострадавшими"
    # Чужую аббревиатуру и обычные слова не трогаем.
    assert unglued("звонили в МЧС, ДТПСК", facts) == "звонили в МЧС, ДТПСК"


def test_who_by_service_number_and_latin_dispatcher():
    # Живой доклад на стенде 12.10: «кто вы» был, но не засчитывался.
    tail = " Дубнинская улица, дом 1, ДТП. Работаем по карточке 10000001. Требуется скорая."
    assert choice("Обучаемый 01, служба 102." + tail) == "full"
    assert choice("Обучаемый 01, служба номер 102." + tail) == "full"
    assert choice("Обучаемый 01 Dispatcher." + tail) == "full"
    # Служба без номера — не представление: «требуется газовая служба».
    assert choice("Обучаемый 01." + tail + " Нужна газовая служба.") == "no_who"


@pytest.mark.parametrize(
    ("service", "incident"),
    [
        ("104", "газовая труба повреждена"),
        ("104", "аварийная ситуация во дворе"),
        ("101", "пожарная лестница сломана"),
        ("101", "пожарная сигнализация сработала"),
        ("101", "пожарные лестницы перекрыты"),
        ("102", "полицейский автомобиль перегородил двор"),
        ("104", "газовое оборудование повреждено"),
    ],
)
def test_incident_adjective_is_not_a_service_introduction(service, incident):
    scenario = {**SCENARIO, "service_id": service}
    # Остальные части доклада полные: ошибка именно в ложном «кто вы», а не в адресе.
    text = (
        f"Дубнинская улица, дом 1, ДТП, {incident}. "
        "Работаем по карточке 10000001. Ситуация изменилась."
    )
    assert parts(text, scenario) == ("address", "card", "change")
    assert choice(text, scenario) == "no_who"


@pytest.mark.parametrize(
    ("service", "introduction"),
    [
        ("101", "Это пожарные"),
        ("101", "Пожарная охрана"),
        ("101", "Пожарная часть"),
        ("101", "На связи МЧС"),
        ("102", "Полиция"),
        ("102", "Полицейские"),
        ("103", "Это скорая"),
        ("103", "Вас вызывает скорая помощь"),
        ("103", "Прошу принять, скорая"),
        ("104", "Газовая служба"),
        ("104", "Вызывает аварийная газовая служба"),
        ("104", "Прошу принять вызов, газовая служба"),
        ("104", "Вызывает Мосгаз"),
        ("104", "Газовая"),
        ("104", "Звоню из газовой службы"),
    ],
)
def test_named_service_still_completes_the_report(service, introduction):
    scenario = {**SCENARIO, "service_id": service}
    text = (
        f"{introduction}. Дубнинская улица, дом 1, ДТП. "
        "Работаем по карточке 10000001. Ситуация изменилась."
    )
    assert parts(text, scenario) == ("who", "address", "card", "change")
    assert choice(text, scenario) == "full"
    assert parts(introduction, scenario) == ("who",)


@pytest.mark.parametrize(
    ("service", "text"),
    [
        ("104", "Просим выслать газовую службу"),
        ("104", "Нужна аварийная газовая служба"),
        ("104", "Прошу принять вызов, газовая служба требуется"),
        ("104", "Вызываем Мосгаз"),
        ("103", "Нужна скорая помощь"),
        ("103", "Прошу, скорая нужна"),
        ("101", "Вызываем пожарные"),
        ("101", "Это Мосгаз"),
        ("104", "Это пожарные"),
        ("104", "Мосгазификация дома завершена"),
    ],
)
def test_request_or_another_service_is_not_an_introduction(service, text):
    scenario = {**SCENARIO, "service_id": service}
    assert "who" not in parts(text, scenario)
    assert choice(text, scenario) == "no_who"


@pytest.mark.parametrize(
    ("service", "introduction"),
    [
        ("101", "Это пожарные"),
        ("101", "На связи пожарная"),
        ("101", "Прошу принять, пожарные"),
        ("102", "Это полицейские"),
        ("103", "На связи скорая"),
        ("104", "Вас вызывает газовая"),
        ("104", "Прошу принять, аварийная газовая"),
    ],
)
@pytest.mark.parametrize(
    "continuation",
    [
        "Дубнинская улица, дом 1, ДТП. Работаем по карточке 10000001. Ситуация изменилась.",
        "по карточке 10000001. Дубнинская улица, дом 1, ДТП. Ситуация изменилась.",
    ],
)
def test_short_service_introduction_without_punctuation(service, introduction, continuation):
    scenario = {**SCENARIO, "service_id": service}
    text = f"{introduction} {continuation}"
    assert service_named(scenario, text)
    assert parts(text, scenario) == ("who", "address", "card", "change")
    assert choice(text, scenario) == "full"


@pytest.mark.parametrize("prefix", ["", "Это ", "На связи ", "Вас вызывает ", "Прошу принять, "])
@pytest.mark.parametrize(
    ("service", "incident"),
    [
        ("104", "газовая труба повреждена"),
        ("104", "аварийная ситуация во дворе"),
        ("101", "пожарная лестница сломана"),
        ("101", "пожарная сигнализация сработала"),
        ("101", "пожарные лестницы перекрыты"),
        ("102", "полицейский автомобиль перегородил двор"),
        ("104", "газовое оборудование повреждено"),
        ("103", "скорая расправа"),
    ],
)
def test_incident_object_is_not_a_service_even_after_introduction(service, incident, prefix):
    scenario = {**SCENARIO, "service_id": service}
    text = (
        f"{prefix}{incident}. Дубнинская улица, дом 1, ДТП. "
        "Работаем по карточке 10000001. Ситуация изменилась."
    )
    assert not service_named(scenario, text)
    assert parts(text, scenario) == ("address", "card", "change")
    assert choice(text, scenario) == "no_who"


@pytest.mark.parametrize(
    ("service", "introduction"),
    [
        ("103", "Звоню из скорой"),
        ("101", "На связи пожарно-спасательная часть"),
        ("101", "Звоню из пожарно-спасательной части"),
    ],
)
@pytest.mark.parametrize("separator", [". ", " "])
def test_inflected_or_compound_service_introduction(service, introduction, separator):
    scenario = {**SCENARIO, "service_id": service}
    text = (
        f"{introduction}{separator}Дубнинская улица, дом 1, ДТП. "
        "Работаем по карточке 10000001. Ситуация изменилась."
    )
    assert service_named(scenario, introduction + ".")
    assert service_named(scenario, text)
    assert parts(text, scenario) == ("who", "address", "card", "change")
    assert choice(text, scenario) == "full"


@pytest.mark.parametrize(
    ("service", "text"),
    [
        ("103", "Звоню из скорой расправы"),
        ("101", "На связи пожарно-спасательная лестница"),
        ("101", "Пожарно-спасательная лестница"),
        ("101", "Нужна пожарно-спасательная часть"),
        ("104", "На связи пожарно-спасательная часть"),
        ("101", "Звоню из скорой"),
        ("103", "Скорой расправы удалось избежать"),
        ("103", "Это скоростная дорога"),
        ("104", "Это газоваяхимия"),
    ],
)
def test_inflected_or_compound_name_rejects_objects_requests_and_other_service(service, text):
    scenario = {**SCENARIO, "service_id": service}
    assert not service_named(scenario, text)
    assert "who" not in parts(text, scenario)
    assert choice(text, scenario) == "no_who"


# Конечный набор поддержанных названий: матрица не выводит эталон из regex реализации.
NOMINATIVE_SERVICE_NAMES = [
    ("101", "пожарная охрана"),
    ("101", "пожарная часть"),
    ("101", "пожарная служба"),
    ("101", "пожарная бригада"),
    ("101", "пожарно-спасательная часть"),
    ("101", "пожарная"),
    ("101", "пожарные"),
    ("101", "пожарный"),
    ("101", "спасатель"),
    ("101", "спасатели"),
    ("101", "МЧС"),
    ("102", "полиция"),
    ("102", "милиция"),
    ("102", "полицейский"),
    ("102", "полицейские"),
    ("103", "скорая"),
    ("103", "скорая помощь"),
    ("103", "скорая медицинская помощь"),
    ("103", "медик"),
    ("103", "медики"),
    ("104", "газовая служба"),
    ("104", "газовая бригада"),
    ("104", "аварийная газовая служба"),
    ("104", "аварийная газовая бригада"),
    ("104", "аварийная служба"),
    ("104", "аварийная бригада"),
    ("104", "газовая"),
    ("104", "аварийная газовая"),
    ("104", "Мосгаз"),
    ("104", "Горгаз"),
]
INTRODUCTION_PREFIXES = [
    "Это ",
    "На связи ",
    "Вас вызывает ",
    "Вызывает ",
    "Прошу принять ",
    "Прошу принять, ",
    "Прошу принять вызов, ",
    "Просим принять ",
    "Просим принять, ",
    "Просим принять вызов, ",
]
REPORT_CONTINUATIONS = [
    "",
    ". Дубнинская улица, дом 1, ДТП. Работаем по карточке 10000001. Ситуация изменилась.",
    " Дубнинская улица, дом 1, ДТП. Работаем по карточке 10000001. Ситуация изменилась.",
    ", по карточке 10000001. Дубнинская улица, дом 1, ДТП. Ситуация изменилась.",
    " по карточке 10000001. Дубнинская улица, дом 1, ДТП. Ситуация изменилась.",
]


def assert_service_introduction(service, text, complete):
    # Каждый вариант — своя служба и все три чужие; должность/номер не маскируют ошибку.
    for target in ("101", "102", "103", "104"):
        scenario = {**SCENARIO, "service_id": target}
        own = target == service
        assert service_named(scenario, text) is own, (target, text)
        said = parts(text, scenario)
        assert ("who" in said) is own, (target, text)
        if complete:
            assert said == (("who",) if own else ()) + ("address", "card", "change")
        expected_choice = "full" if own and complete else "no_address" if own else "no_who"
        assert choice(text, scenario) == expected_choice, (target, text)


@pytest.mark.parametrize(("service", "name"), NOMINATIVE_SERVICE_NAMES)
@pytest.mark.parametrize("prefix", INTRODUCTION_PREFIXES)
@pytest.mark.parametrize("continuation", REPORT_CONTINUATIONS)
def test_nominative_service_introduction_matrix(service, name, prefix, continuation):
    assert_service_introduction(service, prefix + name + continuation, bool(continuation))
    if name == "пожарно-спасательная часть" and not continuation:
        assert parts(prefix + name, {**SCENARIO, "service_id": service}) == ("who",)


@pytest.mark.parametrize(("service", "name"), NOMINATIVE_SERVICE_NAMES)
@pytest.mark.parametrize(
    "template",
    [
        "Нужна {}",
        "Вызываем {}",
        "Вызывают {}",
        "Просим выслать {}",
        "Прошу, {}",
        "Вас вызывает {} требуется",
        "Прошу принять вызов, {} требуется",
        "Просим принять вызов, {} требуется",
    ],
)
def test_nominative_service_request_matrix(service, name, template):
    scenario = {**SCENARIO, "service_id": service}
    text = template.format(name)
    assert not service_named(scenario, text)
    assert "who" not in parts(text, scenario)
    assert choice(text, scenario) == "no_who"


GENITIVE_SERVICE_NAMES = [
    ("101", "пожарной охраны"),
    ("101", "пожарной части"),
    ("101", "пожарной службы"),
    ("101", "пожарной бригады"),
    ("101", "пожарно-спасательной части"),
    ("101", "пожарной"),
    ("101", "спасателя"),
    ("101", "спасателей"),
    ("101", "МЧС"),
    ("102", "полиции"),
    ("102", "милиции"),
    ("103", "скорой"),
    ("103", "скорой помощи"),
    ("103", "скорой медицинской помощи"),
    ("103", "медика"),
    ("103", "медиков"),
    ("104", "газовой службы"),
    ("104", "газовой бригады"),
    ("104", "аварийной газовой службы"),
    ("104", "аварийной газовой бригады"),
    ("104", "аварийной службы"),
    ("104", "аварийной бригады"),
    ("104", "газовой"),
    ("104", "аварийной газовой"),
    ("104", "Мосгаза"),
    ("104", "Горгаза"),
]


@pytest.mark.parametrize(("service", "name"), GENITIVE_SERVICE_NAMES)
@pytest.mark.parametrize("continuation", REPORT_CONTINUATIONS)
def test_genitive_service_introduction_matrix(service, name, continuation):
    assert_service_introduction(service, "Звоню из " + name + continuation, bool(continuation))


@pytest.mark.parametrize(("service", "name"), GENITIVE_SERVICE_NAMES)
@pytest.mark.parametrize("prefix", ["Нужна ", "Вызываем ", "Просим выслать "])
def test_genitive_service_request_matrix(service, name, prefix):
    scenario = {**SCENARIO, "service_id": service}
    text = prefix + name
    assert not service_named(scenario, text)
    assert "who" not in parts(text, scenario)
    assert choice(text, scenario) == "no_who"


@pytest.mark.parametrize(
    ("service", "name"),
    [("101", "пожарной"), ("103", "скорой"), ("104", "газовой"), ("104", "аварийной газовой")],
)
@pytest.mark.parametrize("prefix", ["", "Вас вызывает ", "Прошу принять, "])
@pytest.mark.parametrize("continuation", REPORT_CONTINUATIONS)
def test_genitive_short_name_requires_self_introduction(service, name, prefix, continuation):
    scenario = {**SCENARIO, "service_id": service}
    text = prefix + name + continuation
    assert not service_named(scenario, text)
    assert "who" not in parts(text, scenario)
    assert choice(text, scenario) == "no_who"


@pytest.mark.parametrize("prefix", ["", "Звоню из ", *INTRODUCTION_PREFIXES])
@pytest.mark.parametrize("continuation", REPORT_CONTINUATIONS)
@pytest.mark.parametrize(
    ("service", "text"),
    [
        ("101", "пожарная лестница"),
        ("101", "пожарная сигнализация"),
        ("101", "пожарные лестницы"),
        ("101", "пожарной лестницы"),
        ("101", "пожарной сигнализации"),
        ("101", "пожарно-спасательная лестница"),
        ("101", "пожарно-спасательной лестницы"),
        ("101", "пожарнойхимии"),
        ("102", "полицейский автомобиль"),
        ("102", "полицейского автомобиля"),
        ("103", "скорая расправа"),
        ("103", "скорой расправы"),
        ("103", "скоростная дорога"),
        ("104", "газовая труба"),
        ("104", "газовой трубы"),
        ("104", "аварийной газовой трубы"),
        ("104", "аварийная ситуация"),
        ("104", "газовое оборудование"),
        ("104", "газовойхимии"),
        ("104", "Мосгазификация"),
    ],
)
def test_service_object_introduction_matrix(service, text, prefix, continuation):
    scenario = {**SCENARIO, "service_id": service}
    text = prefix + text + continuation
    assert not service_named(scenario, text)
    assert "who" not in parts(text, scenario)
    assert choice(text, scenario) == "no_who"


@pytest.mark.parametrize(
    ("service", "phrase"),
    [
        ("104", "Это газовая утечка"),
        ("104", "Это газовая плита"),
        ("101", "Это пожарная опасность"),
        # Не только три слова из ревью: предметы, явления, определения и падежи.
        ("104", "Это газовая колонка"),
        ("104", "Это газовая горелка"),
        ("104", "Это газовая смесь"),
        ("104", "Это газовая сильная утечка"),
        ("104", "На связи аварийная газовая установка"),
        ("104", "Вас вызывает газовая котельная"),
        ("104", "Прошу принять, газовая емкость"),
        ("104", "Звоню из газовой котельной"),
        ("104", "Звоню из аварийной газовой установки"),
        ("101", "Это пожарная безопасность"),
        ("101", "Это пожарные рукава"),
        ("101", "На связи пожарный извещатель"),
        ("101", "Звоню из пожарной зоны"),
        ("102", "Это полицейский участок"),
        ("102", "Это полицейские машины"),
        ("103", "Это скорая смерть"),
        ("103", "Звоню из скорой поездки"),
        # Начало другой части позже в предложении не завершает короткое имя.
        ("104", "Это газовая утечка по карточке 10000001"),
        ("104", "Это газовая плита на Дубнинской улице"),
        ("101", "Это пожарная опасность ситуация изменилась"),
    ],
)
def test_short_name_noun_continuation_is_not_introduction(service, phrase):
    scenario = {**SCENARIO, "service_id": service}
    text = (
        f"Дубнинская улица, дом 1, ДТП. {phrase}. "
        "Работаем по карточке 10000001. Ситуация изменилась."
    )
    assert not service_named(scenario, text)
    assert parts(text, scenario) == ("address", "card", "change")
    assert choice(text, scenario) == "no_who"


@pytest.mark.parametrize(
    ("service", "text"),
    [
        ("104", "Это газовая"),
        ("104", "Это газовая служба"),
        ("101", "Это пожарная охрана"),
        ("104", "Звоню из аварийной газовой"),
        ("101", "Звоню из пожарно-спасательной части"),
        ("101", "Это пожарные. Ситуация изменилась"),
        ("102", "Это полицейские, по карточке 10000001"),
        ("103", "Прошу принять, скорая: Дубнинская улица, дом 1"),
        ("104", "Это газовая Дубнинская улица, дом 1"),
        ("101", "Звоню из пожарной Дубнинская 1"),
        ("104", "На связи аварийная газовая улица Дубнинская, дом 1"),
        ("103", "Звоню из скорой по адресу Дубнинская улица, дом 1"),
        ("102", "Это полицейский адрес Дубнинская улица, дом 1"),
        ("104", "Вас вызывает газовая по карточке 10000001"),
        ("101", "Это пожарная карточка 10000001"),
        ("103", "На связи скорая работаем по карточке 10000001"),
        ("104", "Это газовая ситуация изменилась"),
        ("101", "Это пожарные докладываем обстановку"),
        ("104", "Это газовая сообщаю обстановку"),
    ],
)
def test_short_name_ends_before_next_report_part(service, text):
    assert_service_introduction(service, text, complete=False)


@pytest.mark.parametrize(
    ("street", "address"),
    [
        ("Дубнинская улица", "на Дубнинской улице"),
        ("Дубнинская улица", "на улице Дубнинской"),
        ("Дубнинская улица", "ул. Дубнинская"),
        ("улица Академика Янгеля", "улица Академика Янгеля"),
        ("улица Академика Янгеля", "Янгеля 6"),
        ("Большая Академическая улица", "на Большой Академической улице"),
    ],
)
def test_short_name_before_unpunctuated_scenario_address(street, address):
    # В адресе бывают падежи и звания; они не превращают представление в описание предмета.
    scenario = {
        **SCENARIO,
        "service_id": "104",
        "reference": {**SCENARIO["reference"], "expected_address": {"street": street}},
    }
    text = f"Это газовая {address}, дом 1"
    assert service_named(scenario, text)
    assert "who" in parts(text, scenario)
    assert choice(text, scenario) == "no_address"  # Повод ещё не назван.


def test_card_number_dictated_digit_by_digit():
    assert card_number_said(SCENARIO, "карточка 1.0.0.0.0.0.0.1")


def test_recognition_hints_name_both_streets_and_incident():
    scenario = {
        "card": {"address": {"street": "Дубининская улица"}, "incident_class": "Пожар"},
        "reference": {"expected_address": {"street": "Дубнинская улица"}},
    }
    hints = recognition_hints(scenario)
    assert hints[:3] == ("Дубининская улица", "Дубнинская улица", "Пожар")
    assert "диспетчер" in hints
    assert recognition_hints(SCENARIO)[0].startswith("Дубнинская")


# Карточка 70005312 со стенда 12.10: доклад одной фразой не засчитывался ни в одной части.
KASHIRKA = {
    "card": {
        "number": "70005312",
        "address": {"street": "Каширское шоссе", "house": "26"},
        "incident_class": "ДТП с заблокированными",
        "description": "Столкнулись два легковых автомобиля. В одном зажат водитель, в "
        "сознании, выйти не может. Пассажирка второго автомобиля жалуется на боль в шее.",
    },
    "reference": {"expected_address": {"street": "Каширское шоссе", "house": "26"}},
}


def test_one_phrase_report_from_stand_journal():
    # Распознано дословно; «сто два» Whisper пишет «СТО-2», повод — пересказом описания.
    said = (
        "Служба СТО-2 Каширское шоссе 26 Столкнулись два лихых автомобиля, в одном зажат "
        "водитель в сознании выйти не может."
    )
    assert parts(said, KASHIRKA) == ("who", "address", "change")
    assert choice(said, KASHIRKA) == "no_card"


def test_service_number_in_words_and_dispatch_in_progress():
    assert spoken_numbers("служба сто два") == "служба 102"
    assert spoken_numbers("Служба сто-1") == "Служба 101"
    # «Стол», «стоп» — не число.
    assert spoken_numbers("стоп два") == "стоп 2"
    assert parts("пока ничего, отправляю бригаду", KASHIRKA) == ("change",)


def test_scene_words_from_incident_class_are_not_a_change():
    # «Заблокированные» — уже повод этой карточки, обстановкой не считается.
    assert "change" not in parts("Каширское шоссе 26, ДТП с заблокированными", KASHIRKA)
    # Одно общее слово описания — ещё не пересказ.
    assert "address" not in parts("Каширское шоссе 26, водитель", KASHIRKA)


def test_house_after_boulevard_and_other_street_types():
    # Стенд 12.10, карточка 70005111: «Бескудниковский бульвар 24» адресом не засчитывался.
    address = {"street": "Бескудниковский бульвар", "house": "24"}
    scenario = {
        "card": {
            "number": "70005111",
            "address": address,
            "incident_class": "задымление: квартира",
        },
        "reference": {"expected_address": address},
    }
    assert parts("Бескудниковский бульвар 24, квартира 115, идёт дым", scenario) == ("address",)
    assert parts("Бескудниковский б-р, 24, дым в квартире", scenario) == ("address",)
    # Одно слово места — адрес, а не повод (HQ-024, круг 2).
    assert parts("Бескудниковский б-р, 24, квартира", scenario) == ()
    # Другой дом — не адрес.
    assert parts("Бескудниковский бульвар 42, квартира", scenario) == ()


# Стенд 17.10, traffic-fire-102-2: карточка «ДТП без пострадавших - легковой», Варшавское
# шоссе, 87; бригада доложила «под капотом загорелось, нужны пожарные» (task_change).
FIRE = json.loads(
    (Path(__file__).parents[3] / "data" / "scenarios" / "traffic-fire-102-2.json").read_text(
        encoding="utf-8"
    )
)
FIRE_SCENARIO = {key: FIRE[key] for key in ("incident_type_code", "card", "reference")}
FIRE_CHANGES = [item["task_change"] for item in FIRE["plan"] if "task_change" in item]


def fire(text: str, changes=FIRE_CHANGES):
    return voice_report_check(FIRE_SCENARIO, text, FakeChecker(), changes)


def test_changed_situation_is_reason_and_change():
    said = "Варшавское шоссе 87 горит автомобиль"
    # Без перемены задачи «горит» — не повод карточки «ДТП без пострадавших».
    assert fire(said, []).parts == ()
    assert fire(said).parts == ("address", "change")
    assert fire(said).address_gap is None
    assert fire("Варшавское шоссе 87, нужны пожарные").parts == ("address", "change")


def test_number_keyword_of_change_is_not_situation():
    changes = [{"comment_keywords": ["водоканал / ЖКХ", "112"]}]
    assert voice_report_parts(FIRE_SCENARIO, "Звоню в 112", FakeChecker(), changes) == ()


def test_address_gap_names_what_is_missing():
    assert fire("Диспетчер службы 102").address_gap == "place"
    assert fire("Варшавское шоссе 87", []).address_gap == "reason"
    assert fire("Варшавское шоссе, ДТП", []).address_gap == "place"


def test_parts_add_up_over_phrases_of_the_call():
    # Доклад за звонок: прежние фразы и ответ на переспрос — одним текстом.
    first = fire("Варшавское шоссе 87 горит автомобиль")
    second = fire("Обучаемый 0.1. Служба 102")
    together = fire("Варшавское шоссе 87 горит автомобиль. Обучаемый 0.1. Служба 102")
    assert first.parts == ("address", "change") and second.parts == ("who",)
    assert together.parts == ("who", "address", "change")
    assert report_choice(together.parts) == "no_card"


def test_card_is_required_only_in_call_to_112():
    # Памятка ДДС, с. 32: карточку называют, когда звонят в 112; руководителю и службам — нет.
    without_card = ("who", "address", "change")
    assert report_choice(without_card, "112") == "no_card"
    assert report_choice(without_card, "101") == "full"
    assert report_choice(without_card, "401") == "full"
    # Номер не известен — как раньше, все части.
    assert report_choice(without_card) == "no_card"
    assert required_parts("401") == without_card
    assert required_parts("112") == tuple(REPORT_PARTS)


# Стенд 17.10, smoke-apartment-102-1: наряд попросил пожарных («в квартире что-то горит»),
# диспетчер звонит в 101 — «горит квартира» и повод, и то, что изменилось.
SMOKE = json.loads(
    (Path(__file__).parents[3] / "data" / "scenarios" / "smoke-apartment-102-1.json").read_text(
        encoding="utf-8"
    )
)
SMOKE_SCENARIO = {key: SMOKE[key] for key in ("incident_type_code", "card", "reference")}


def test_requested_service_situation_is_change():
    fire_call = [requested_change(["101", "112"])]
    said = "Бескудниковский бульвар 24, квартира 115, 9 этаж. Горит квартира"
    assert "change" not in voice_report_check(SMOKE_SCENARIO, said, FakeChecker()).parts
    assert "change" in voice_report_check(SMOKE_SCENARIO, said, FakeChecker(), fire_call).parts
    assert (
        "change"
        in voice_report_check(SMOKE_SCENARIO, "квартира горит", FakeChecker(), fire_call).parts
    )
    assert requested_change(["112"]) is None
    assert requested_change(["112", "103"]) == {"comment_keywords": [SERVICE_NEEDS["103"]]}
