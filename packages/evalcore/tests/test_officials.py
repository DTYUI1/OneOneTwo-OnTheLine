"""TC-03: должностное лицо и служба отвечают правдоподобно.

Похожие улицы → «по буквам», номер регистрации в комментарии, нейтральные вопросы и
отсутствие обещаний времени прибытия — по данным репозитория (data/, банк озвучки).
"""

import json
import re
from collections.abc import Iterator
from pathlib import Path

import pytest
from evalcore.comment import CommentKeywordsCriterion, comment_facts
from evalcore.models import EvalContext, SpellingIssue
from evalcore.officials import (
    confusable_twin,
    leading_question,
    promises_arrival,
    registration_said,
    street_key,
)


class FakeChecker:
    """Словарь без опечаток: начальная форма — само слово."""

    def check(self, text: str) -> list[SpellingIssue]:
        return []

    def lemmas(self, word: str) -> frozenset[str]:
        return frozenset({word.casefold().replace("ё", "е")})


ROOT = Path(__file__).parents[3]
DATA = ROOT / "data"
PAIRS = json.loads((DATA / "confusable_streets.json").read_text(encoding="utf-8"))["pairs"]
GOLDEN = DATA / "golden_scenarios" / "case-01.json"
BANK = ROOT / "scripts" / "voices" / "bank" / "phrases"
CALLERS = BANK.parent / "callers"


def test_pairs_are_two_different_streets_without_repeats():
    assert len(PAIRS) >= 10
    keys = [street_key(street) for pair in PAIRS for street in pair]
    assert all(len(pair) == 2 for pair in PAIRS)
    assert len(set(keys)) == len(keys), "улица не должна быть в двух парах"
    assert all(name and kind for name, kind in keys), "у каждой улицы — название и тип"


@pytest.mark.parametrize(
    ("street", "twin"),
    [
        ("Дубнинская улица", "Дубининская улица"),
        ("ул. Дубининская", "Дубнинская улица"),
        ("улица ДУБНИНСКАЯ", "Дубининская улица"),
        ("Ленинградский пр-т", "Ленинский проспект"),
        ("Новочеркасский б-р", "Новочеремушкинская улица"),
    ],
)
def test_confusable_street_has_a_twin(street: str, twin: str):
    assert confusable_twin(street, PAIRS) == twin


@pytest.mark.parametrize(
    "street",
    ["Профсоюзная улица", "Бескудниковский бульвар", "Ленинградское шоссе", "Смоленская площадь"],
)
def test_other_streets_have_no_twin(street: str):
    # Другой тип при том же названии — другая улица: «Смоленская площадь» ≠ «Смоленская улица».
    assert confusable_twin(street, PAIRS) is None


def test_registration_number_only_as_a_separate_number():
    assert registration_said("Наряд направлен, номер 72.", "72")
    assert registration_said("рег. №72", "72")
    assert not registration_said("Наряд направлен, номер 73.", "72")
    assert not registration_said("Номер 172, наряд направлен", "72")
    assert not registration_said("Номер 720", "72")
    assert not registration_said("Номер семьдесят два", "72")


def _context(comment: str, number: str | None, answered: bool = True) -> EvalContext:
    fixture = json.loads(GOLDEN.read_text(encoding="utf-8"))
    call = dict(fixture["calls"][0])
    if not answered:
        call["answered_at"] = None
    events = []
    for event in fixture["events"]:
        payload = event.get("payload")
        if isinstance(payload, dict) and "comment" in payload:
            event = {**event, "payload": {**payload, "comment": comment}}
        if event["type"] == "call_hangup" and number is not None:
            event = {**event, "payload": {**payload, "registration_number": number}}
        events.append(event)
    settings = dict(fixture["settings"])
    settings["weights"] = {**settings["weights"], "comment_keywords": 1}
    return EvalContext(
        scenario=fixture["scenario"],
        current={**fixture["current"], "comment": comment},
        events=events,
        calls=[call],
        settings=settings,
        text_checker=FakeChecker(),
    )


def _registration_found(comment: str, number: str | None, answered: bool = True) -> bool | None:
    ctx = _context(comment, number, answered)
    facts = [fact for fact in comment_facts(ctx) if fact.number]
    if not facts:
        return None
    result = CommentKeywordsCriterion().evaluate(ctx)
    have = result.evidence[0]
    return facts[0].label in have


def test_registration_in_comment_counts_and_other_number_does_not():
    comment = "ДТП, пострадавших нет, экипаж направлен, рег. номер 72"
    assert _registration_found(comment, "72") is True
    assert _registration_found(comment.replace("72", "73"), "72") is False
    # Номер не назван (служба без персонажа, старые занятия) — пункта нет, балл как раньше.
    assert _registration_found(comment, None) is None
    # Трубку не сняли — номер никто не называл.
    assert _registration_found(comment, "72", answered=False) is None


def test_registration_label_names_service_and_number():
    facts = [fact for fact in comment_facts(_context("", "72")) if fact.number]
    assert [fact.label for fact in facts] == ["Номер регистрации службы 102: 72"]


@pytest.mark.parametrize(
    "text",
    [
        "Пострадавших двое?",
        "Есть пострадавшие? Трое?",
        "Пострадавших нет, да?",
        "Газа нет, верно?",
        "Наверное, газ?",
        "Ведь никто не пострадал?",
        "В квартире 2 человека?",
    ],
)
def test_leading_questions_are_caught(text: str):
    assert leading_question(text) is not None


@pytest.mark.parametrize(
    "text",
    [
        "Есть пострадавшие?",
        "Есть пострадавшие? Сколько человек?",
        "Газ перекрыли или ещё нет?",
        "Диспетчер, как поняли? Бескудниковский переулок, двадцать четыре, выезжаем!",
        "Что горит? Квартира, подвал?",
        "Номер дома ещё раз, не разобрал.",
    ],
)
def test_neutral_questions_pass(text: str):
    assert leading_question(text) is None


def test_arrival_promises_are_caught():
    assert promises_arrival("Записал. Высылаем, будут в ближайшее время.")
    assert promises_arrival("Наряд будет через десять минут.")
    assert promises_arrival("Будут через пять минут.")
    assert not promises_arrival("Записал. Номер наряда семьдесят два.")
    assert not promises_arrival("Понял, выслали отделение.")


# Реплики собеседников в data/: доклады и вопросы бригад, реплики служб и заявителя. Не
# реплики: карточка, эталон, варианты ответа обучаемого и вопросы самого оператора.
_SPEECH = re.compile(
    r"(?:^|\.)(?:line|with|departure|arrival|works|completion|outcome|opening|reply|panic|"
    r"hysteria|calming|not_understood|pause|irrelevant|phrases)(?:\.text)?(?:\[\])?$"
    r"|messages\[\]\.text$|answers\.[a-z_]+\.[a-z_]+$"
)
_NOT_SPEECH = ("input_parts", "reply_options", "distractors[].text", "questionnaires")
_SKIP_DIRS = ("ticket_scenarios", "golden_scenarios", "generated_packs", "seed", "archive")
# Заявитель ДДС (HQ-019, docs/dds_caller.md) — источник сведений: он отвечает на вопросы
# диспетчера, а не спрашивает его. Вопросительны в его ответах только переспрос прочитанного
# диспетчером адреса («85? Нет… 58», место correct_address) и неуверенность неполного ответа
# («пять? Десять?», tell_* с on: first); ответа обучаемого они не ждут. Остальные реплики
# заявителя — и его вопросы (кто звонит, не расслышала, «Алло, вы тут?») — проверяются, как у всех.


def _caller_answers() -> frozenset[str]:
    return frozenset(
        phrase["id"]
        for file in sorted(CALLERS.glob("*.json"))
        for phrase in json.loads(file.read_text(encoding="utf-8"))["phrases"]
        if phrase["slot"] == "correct_address"
        or (phrase["slot"].startswith("tell_") and phrase.get("on") == "first")
    )


_CALLER_ANSWERS = _caller_answers()


def _speech(value: object, path: str) -> Iterator[tuple[str, str]]:
    if isinstance(value, dict):
        if value.get("id") in _CALLER_ANSWERS:
            return  # Заявитель переспрашивает и сомневается; это не наводящий вопрос диспетчера.
        for key, item in value.items():
            yield from _speech(item, f"{path}.{key}")
    elif isinstance(value, list):
        for item in value:
            yield from _speech(item, f"{path}[]")
    elif (
        isinstance(value, str)
        and _SPEECH.search(path)
        and not any(part in path for part in _NOT_SPEECH)
    ):
        yield path, value


def _data_speech() -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []
    for file in sorted(DATA.rglob("*.json")):
        relative = file.relative_to(DATA).as_posix()
        if file.name == "classifier.json" or any(part in relative for part in _SKIP_DIRS):
            continue
        data = json.loads(file.read_text(encoding="utf-8"))
        found += [(f"{relative}{path}", text) for path, text in _speech(data, "")]
    return found


def test_no_interlocutor_line_in_data_hints_the_answer():
    speech = _data_speech()
    # Проверка не пустая: доклады, вопросы бригад и реплики заявителя найдены.
    assert len(speech) > 300
    assert sum("?" in text for _, text in speech) > 20
    assert len(_CALLER_ANSWERS) > 4, "книги заявителя (scripts/voices/bank/callers) не найдены"
    leading = [f"{path}: {hint}" for path, text in speech if (hint := leading_question(text))]
    assert leading == []


# Что окно телефона говорит за должностное лицо (bankPhrases.json, scripts/voices/bank/web.py):
# все места, кроме «accepted» — из него звучит только Q14 «Я вас понял, информация принята».
_WINDOW_SLOTS = {
    "answer",
    "registered",
    "ask_who",
    "ask_address",
    "ask_what",
    "ask_card",
    "ask_victims",
    "not_understood",
    "end_call",
}


def _official_phrases() -> list[dict[str, object]]:
    phrases: list[dict[str, object]] = []
    # Новые редакции фраз (revisions/, HQ-037) встанут в окно после записи — те же правила.
    files = [*BANK.glob("OFFICIAL*.json"), *(BANK.parent / "revisions").glob("OFFICIAL*.json")]
    for file in sorted(files):
        book = json.loads(file.read_text(encoding="utf-8"))
        phrases += [p for p in book["phrases"] if p["slot"] in _WINDOW_SLOTS]
        phrases += [p for p in book["phrases"] if p["id"] == "OFFICIAL.accepted.any.1"]
    return phrases


def test_officials_ask_neutrally_and_do_not_promise_arrival():
    phrases = _official_phrases()
    assert len(phrases) > 100
    assert [p["id"] for p in phrases if leading_question(str(p["text"]))] == []
    assert [p["id"] for p in phrases if promises_arrival(str(p["text"]))] == []


def test_each_service_official_names_a_registration_number():
    for service in ("101", "102", "103", "104"):
        book = json.loads((BANK / f"OFFICIAL_{service}.json").read_text(encoding="utf-8"))
        registered = [p for p in book["phrases"] if p["slot"] == "registered"]
        assert registered, service
        assert all(str(p["number"]).isdigit() for p in registered)
        # Похожая улица: у дежурного есть просьба повторить улицу по буквам.
        assert any(
            p["slot"] == "ask_address" and "по буквам" in str(p["text"]) for p in book["phrases"]
        ), service
