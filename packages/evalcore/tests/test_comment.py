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


def context(comment: str, **weights: float) -> EvalContext:
    fixture = json.loads(GOLDEN.read_text(encoding="utf-8"))
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


def test_empty_comment_scores_only_when_required():
    required = SpellingCriterion().evaluate(context("  ", spelling=1))
    assert required.score == 0
    optional = replace(
        context("", spelling=1),
        scenario={
            **context("").scenario,
            "reference": {**context("").scenario["reference"], "required_fields": []},
        },
    )
    assert SpellingCriterion().evaluate(optional).score == 1


def test_keywords_find_facts_by_lemma_and_typos():
    ctx = context(
        "ДТП на Дубнинской улице д.1, двое пострадвших, направлена бригада",
        comment_keywords=1,
    )
    result = CommentKeywordsCriterion().evaluate(ctx)
    assert result.score == 1, result.evidence
    assert result.evidence[1] == "Не хватает: нет"


def test_keywords_do_not_accept_a_similar_street_or_other_number():
    ctx = context("ДТП на Дубининской улице д.1, пострадавших нет", comment_keywords=1)
    result = CommentKeywordsCriterion().evaluate(ctx)
    assert "Адрес: Дубнинская улица, д. 1" in result.evidence[1]
    # Число вдали от улицы и без «д.» — не номер дома.
    other = context("Дубнинская улица, пострадавших двое, направлен 1 экипаж", comment_keywords=1)
    assert "Адрес" in CommentKeywordsCriterion().evaluate(other).evidence[1]
    short = context("Дубнинская 1, ДТП, пострадавших двое, направлен экипаж", comment_keywords=1)
    assert CommentKeywordsCriterion().evaluate(short).score == 1


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
