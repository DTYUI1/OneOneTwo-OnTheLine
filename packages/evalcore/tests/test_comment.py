"""Критерии комментария: грамотность и ключевые сведения (28.09) на поддельном словаре."""

import json
import re
from dataclasses import replace
from pathlib import Path

import pytest
from evalcore.comment import CommentKeywordsCriterion, SpellingCriterion, comment_facts
from evalcore.defaults import COMMENT_CRITERIA, COMMENT_WEIGHTS, CRITERIA
from evalcore.models import EvalContext, SpellingIssue
from evalcore.scoring import configured_weights, evaluate

GOLDEN = Path(__file__).parents[3] / "data" / "golden_scenarios" / "case-01.json"
# Опечатка → исправление; слово → начальная форма. Остальные слова считаются верными.
TYPOS = {"улца": "улица", "пострадвших": "пострадавших", "экипаж": "экипаж"}
LEMMAS = {
    "пострадавших": "пострадавший",
    "пострадавшими": "пострадавший",
    "направлен": "направить",
    "направлена": "направить",
    "дубнинской": "дубнинский",
    "дубнинская": "дубнинский",
    "дубининской": "дубининский",
    "бригада": "бригада",
    "газа": "газ",
}


class FakeChecker:
    def check(self, text: str) -> list[SpellingIssue]:
        return [
            SpellingIssue(match.start(), match.end(), match.group(), (TYPOS[match.group()],))
            for match in re.finditer(r"[а-яё]+", text)
            if match.group() in TYPOS and TYPOS[match.group()] != match.group()
        ]

    def lemmas(self, word: str) -> frozenset[str]:
        word = word.casefold().replace("ё", "е")
        return frozenset({LEMMAS.get(word, word)})


def context(comment: str, card_street: str | None = None, **weights: float) -> EvalContext:
    fixture = json.loads(GOLDEN.read_text(encoding="utf-8"))
    if card_street is not None:
        # Адрес уточнён: в карточке другая улица, эталон — уточнённый адрес (DT-14).
        fixture["scenario"]["card"]["address"]["street"] = card_street
    settings = dict(fixture["settings"])
    settings["weights"] = {**settings["weights"], **weights}
    return EvalContext(
        scenario=fixture["scenario"],
        current={**fixture["current"], "comment": comment},
        # Комментарий проверяемого текста — у каждого статуса, иначе эталонный текст
        # событий подсказал бы ключевые сведения.
        events=[
            {**event, "payload": {**event["payload"], "comment": comment}}
            if isinstance(event.get("payload"), dict) and "comment" in event["payload"]
            else event
            for event in fixture["events"]
        ],
        calls=fixture["calls"],
        settings=settings,
        text_checker=FakeChecker(),
    )


def test_spelling_score_depends_on_error_density():
    clean = SpellingCriterion().evaluate(context("ДТП на улице, экипаж направлен", spelling=1))
    one = SpellingCriterion().evaluate(context("ДТП на улца, экипаж направлен", spelling=1))
    two = SpellingCriterion().evaluate(context("улца улца пострадвших", spelling=1))
    assert clean.score == 1 and clean.explanation == "Ошибок в комментарии не найдено."
    assert one.score == pytest.approx(0.75)
    assert "«улца» → «улица»" in one.evidence
    assert two.score == pytest.approx(0.25)


def test_empty_comment_is_not_scored_regardless_of_requirement():
    required = SpellingCriterion().evaluate(context("  ", spelling=1))
    assert required.score == 0
    assert required.weight == 0
    optional = replace(
        context("", spelling=1),
        scenario={
            **context("").scenario,
            "reference": {**context("").scenario["reference"], "required_fields": []},
        },
    )
    assert SpellingCriterion().evaluate(optional).weight == 0


def test_keywords_find_facts_by_lemma_and_typos():
    ctx = context(
        "ДТП на Дубнинской улице д.1, двое пострадвших, направлена бригада",
        comment_keywords=1,
    )
    result = CommentKeywordsCriterion().evaluate(ctx)
    assert result.score == 1, result.evidence
    assert result.evidence[1] == "Не хватает: нет"


CLARIFIED = "Дубининская улица"


def test_keywords_do_not_accept_a_similar_street_or_other_number():
    ctx = context("ДТП на Дубининской улице д.1, пострадавших нет", CLARIFIED, comment_keywords=1)
    result = CommentKeywordsCriterion().evaluate(ctx)
    assert "Адрес: Дубнинская улица, д. 1" in result.evidence[1]
    # Число вдали от улицы и без «д.» — не номер дома.
    other = context(
        "Дубнинская улица, пострадавших двое, направлен 1 экипаж", CLARIFIED, comment_keywords=1
    )
    assert "Адрес" in CommentKeywordsCriterion().evaluate(other).evidence[1]
    short = context(
        "Дубнинская 1, ДТП, пострадавших двое, направлен экипаж", CLARIFIED, comment_keywords=1
    )
    assert CommentKeywordsCriterion().evaluate(short).score == 1


def test_correct_card_address_is_not_a_required_fact():
    """DT-14: верный адрес карточки диспетчер ДДС в комментарии может не повторять."""
    plain = context("ДТП, двое пострадавших, направлена бригада", comment_keywords=1)
    assert not any(fact.label.startswith("Адрес") for fact in comment_facts(plain))
    assert CommentKeywordsCriterion().evaluate(plain).score == 1
    clarified = context("ДТП", CLARIFIED, comment_keywords=1)
    assert any(fact.label.startswith("Адрес") for fact in comment_facts(clarified))


def test_victims_word_does_not_name_the_incident():
    ctx = context("пострадавших двое, служба действует по плану", comment_keywords=1)
    result = CommentKeywordsCriterion().evaluate(ctx)
    assert "Происшествие: ДТП с пострадавшими" in result.evidence[1]
    assert "Сведения о пострадавших" in result.evidence[0]


def test_teacher_keywords_accept_any_variant():
    ctx = context("Запах газа в подъезде", comment_keywords=1)
    reference = {**ctx.scenario["reference"], "comment_keywords": ["утечка / запах газа"]}
    ctx = replace(ctx, scenario={**ctx.scenario, "reference": reference})
    labels = [fact.label for fact in comment_facts(ctx)]
    assert labels[-1] == "Ключевые слова: утечка / запах газа"
    assert (
        "Ключевые слова: утечка / запах газа"
        in CommentKeywordsCriterion().evaluate(ctx).evidence[0]
    )


def test_comment_weights_are_optional_and_old_settings_keep_totals():
    ctx = context("ДТП")
    assert set(configured_weights(ctx.settings)) == set(CRITERIA)
    old = evaluate(replace(ctx, text_checker=None))
    assert [item.key for item in old.criteria] == list(CRITERIA)
    new = evaluate(
        replace(
            ctx,
            settings={**ctx.settings, "weights": {**ctx.settings["weights"], **COMMENT_WEIGHTS}},
        )
    )
    assert [item.key for item in new.criteria] == [*CRITERIA, *COMMENT_CRITERIA]


def test_comment_criteria_need_a_checker():
    ctx = replace(context("ДТП", spelling=1), text_checker=None)
    with pytest.raises(ValueError, match="text_checker"):
        evaluate(ctx)


def test_keywords_count_every_status_comment():
    """Сведения, написанные при «Принята», не теряются, когда последний статус с коротким
    комментарием затирает текущий комментарий карточки."""
    ctx = context("Работы завершены", comment_keywords=1)
    first = next(event for event in ctx.events if event.get("type") == "status_change")
    full = replace(
        ctx,
        events=[
            {
                **event,
                "payload": {
                    **event["payload"],
                    "comment": "ДТП на Дубнинской улице д.1, двое пострадвших, "
                    "карточка принята, направлена бригада",
                },
            }
            if event is first
            else event
            for event in ctx.events
        ],
    )
    only_last = CommentKeywordsCriterion().evaluate(ctx)
    spread = CommentKeywordsCriterion().evaluate(full)
    assert only_last.score < 1
    assert spread.score == 1


def _with_keyword(ctx: EvalContext, keyword: str, *lines: dict) -> EvalContext:
    reference = {**ctx.scenario["reference"], "comment_keywords": [keyword]}
    return replace(ctx, scenario={**ctx.scenario, "reference": reference}, lines=lines)


GAS_LINE = "Прибыли. В подъезде запах газа, жильцов выводим."
GAS = "Ключевые слова: запах газа"


def test_fact_from_the_conversation_counts_only_after_it_was_heard():
    """HQ-020: сведение из доклада бригады засчитано, только если доклад прозвучал до записи.

    Комментарий у всех статусов — 09:00:15…09:01:40 (case-01)."""
    ctx = context("ДТП, двое пострадавших, направлена бригада, запах газа", comment_keywords=1)
    heard = _with_keyword(
        ctx, "запах газа", {"text": GAS_LINE, "presented_at": "2026-09-19T09:00:30Z"}
    )
    result = CommentKeywordsCriterion().evaluate(heard)
    assert result.score == 1 and GAS in result.evidence[0]

    # Доклад прозвучал после последнего комментария: сведение угадано.
    late = _with_keyword(
        ctx, "запах газа", {"text": GAS_LINE, "presented_at": "2026-09-19T09:05:00Z"}
    )
    result = CommentKeywordsCriterion().evaluate(late)
    assert result.score < 1 and GAS in result.evidence[1]
    assert f"«{GAS}» — записано до того, как прозвучало в разговоре, — не засчитано" in (
        result.evidence
    )
    assert "в разговоре ещё не прозвучали: 1" in result.explanation

    # Доклад плана так и не прозвучал (карточку не довели): сведение угадано.
    never = _with_keyword(
        ctx, "запах газа", {"text": GAS_LINE, "presented_at": None, "planned": True}
    )
    result = CommentKeywordsCriterion().evaluate(never)
    assert f"«{GAS}» — в разговоре не прозвучало — не засчитано" in result.evidence


def test_line_of_a_branch_that_never_fired_is_not_the_source():
    """HQ-020: реплика несработавшей ветки или события не делает сведение «разговорным».

    Диспетчер мог узнать его иначе (звонок заявителю): засчитано, как знание диспетчера. Та же
    реплика, предъявленная после комментария, — уже источник, и сведение угадано."""
    ctx = context("ДТП, двое пострадавших, направлена бригада, запах газа", comment_keywords=1)
    branch = _with_keyword(ctx, "запах газа", {"text": GAS_LINE, "presented_at": None})
    assert CommentKeywordsCriterion().evaluate(branch).score == 1
    fired = _with_keyword(
        ctx, "запах газа", {"text": GAS_LINE, "presented_at": "2026-09-19T09:05:00Z"}
    )
    assert CommentKeywordsCriterion().evaluate(fired).score < 1
    # Сведение есть и в несработавшей ветке, и в прозвучавшем докладе — по докладу.
    both = _with_keyword(
        ctx,
        "запах газа",
        {"text": GAS_LINE, "presented_at": None},
        {"text": "Запах газа сильный.", "presented_at": "2026-09-19T09:00:30Z", "planned": True},
    )
    assert CommentKeywordsCriterion().evaluate(both).score == 1


def test_number_keyword_is_found_as_a_whole_number():
    """Ключевое слово-число («сообщить в 112») находится отдельным числом, не частью другого."""
    said = context("ДТП, двое пострадавших, направлена бригада, сообщено в 112", comment_keywords=1)
    result = CommentKeywordsCriterion().evaluate(_with_keyword(said, "112"))
    assert result.score == 1, result.evidence
    other = context("ДТП, двое пострадавших, направлена бригада, звонок 1123", comment_keywords=1)
    assert CommentKeywordsCriterion().evaluate(_with_keyword(other, "112")).score < 1
    # Вариант «водоканал / 112»: достаточно числа.
    assert CommentKeywordsCriterion().evaluate(_with_keyword(said, "водоканал / 112")).score == 1


def test_fact_from_the_card_or_own_knowledge_counts_always():
    ctx = context(
        "ДТП, двое пострадавших, направлена бригада, сообщено дежурному", comment_keywords=1
    )
    # «дежурный» ни в карточке, ни в репликах нет — знание самого диспетчера.
    own = _with_keyword(ctx, "дежурному", {"text": GAS_LINE, "presented_at": None})
    assert CommentKeywordsCriterion().evaluate(own).score == 1
    # «Дубнинская» есть в карточке: та же реплика её не делает сведением из разговора.
    card = _with_keyword(
        context("ДТП, двое пострадавших, направлена бригада, Дубнинская", comment_keywords=1),
        "Дубнинская",
        {"text": "Мы на Дубнинской", "presented_at": None},
    )
    assert CommentKeywordsCriterion().evaluate(card).score == 1


def test_task_change_keyword_needs_its_report_first():
    """Пункт перемены задачи — из доклада, даже если слов пункта в реплике нет."""
    ctx = context(
        "ДТП, двое пострадавших, направлена бригада, вызваны пожарные", comment_keywords=1
    )
    change = {"label": "горит машина", "comment_keywords": ["пожарные"]}
    reference = {**ctx.scenario["reference"], "comment_keywords": ["пожарные"]}

    def at(presented: str) -> EvalContext:
        return replace(
            ctx,
            scenario={**ctx.scenario, "reference": reference},
            planned_messages=(
                {"message_id": "m", "presented_at": presented, "task_change": change},
            ),
        )

    assert CommentKeywordsCriterion().evaluate(at("2026-09-19T09:01:00Z")).score == 1
    late = CommentKeywordsCriterion().evaluate(at("2026-09-19T09:02:00Z"))
    line = (
        "«Ключевые слова: пожарные» — записано до того, как прозвучало в разговоре, — не засчитано"
    )
    assert line in late.evidence


def test_card_description_in_the_comment_names_incident_and_victims():
    # Разбор 18.10 (traffic-blocked-102-2): описание карточки в комментарии — суть и
    # пострадавшие переданы, хотя слов «ДТП», «заблокированы», «пострадавший» в нём нет.
    scenario = json.loads(
        (GOLDEN.parents[1] / "scenarios" / "traffic-blocked-103-2.json").read_text(encoding="utf-8")
    )
    lemmas = {
        "столкнулись": "столкнуться",
        "зажат": "зажать",
        "сознании": "сознание",
        "жалуется": "жаловаться",
        "заблокированными": "заблокировать",
    }

    class Checker(FakeChecker):
        def lemmas(self, word: str) -> frozenset[str]:
            word = word.casefold().replace("ё", "е")
            return frozenset({lemmas.get(word, LEMMAS.get(word, word))})

    def missing(comment: str) -> str:
        ctx = EvalContext(
            scenario=scenario,
            current={"comment": comment},
            events=[],
            calls=[],
            settings={"weights": {"comment_keywords": 1}},
            text_checker=Checker(),
        )
        result = CommentKeywordsCriterion().evaluate(ctx)
        return next(line for line in result.evidence if line.startswith("Не хватает"))

    described = missing(scenario["card"]["description"])
    assert "Происшествие" not in described and "пострадавших" not in described
    bare = missing("Каширское шоссе, 26, бригада направлена")
    assert "Происшествие: ДТП с заблокированными" in bare and "Сведения о пострадавших" in bare


@pytest.mark.parametrize("text", ["", "   ", "1", "... 123 !"])
def test_spelling_without_words_does_not_contribute_to_total(text):
    ctx = context(text, spelling=1)
    result = SpellingCriterion().evaluate(ctx)
    assert (result.score, result.weight) == (0, 0)
    assert "не оценивается" in result.explanation
    assert evaluate(ctx).total == evaluate(context(text, spelling=0)).total


def test_no_applicable_criteria_does_not_fail_evaluation():
    ctx = context("", **dict.fromkeys(CRITERIA, 0), spelling=1)
    result = evaluate(ctx)
    assert result.total == 0
    assert all(item.weight == 0 for item in result.criteria)
