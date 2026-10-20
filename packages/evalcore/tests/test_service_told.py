"""GP-28: служба вызвана заранее — бригада не просит, просит и слышит «уже едут» или
удивляется приезду; разбор хвалит или делает замечание."""

import pytest
from evalcore.brigade import BrigadeWorkCriterion, effects_of, resolve_event
from evalcore.defaults import BRIGADE_UNTOLD_SCORE
from evalcore.models import EvalContext
from evalcore.service_told import says_service_called, service_reply_option

from .test_brigade_work import WORKS, at, call, ended_call, fired, iso, reply, request_service

EXTS = ("103", "112")


@pytest.mark.parametrize(
    ("text", "named", "told"),
    [
        ("Скорую вызвал, едет", True, True),
        ("скорая уже в пути", True, True),
        ("Врачи выехали, встречайте", True, True),
        ("Уже вызвал, едут", True, False),  # до просьбы без службы — непонятно о чём
        ("Уже вызвал, едут", False, True),
        ("Скорую ещё не вызвал", True, False),
        ("Сейчас вызову скорую", True, False),
        ("Пожарные выехали", True, False),  # не та служба
        ("Доложите обстановку", False, False),
    ],
)
def test_says_service_called(text, named, told):
    assert says_service_called(text, EXTS, named=named) is told


def test_named_service_by_phone_ext():
    assert says_service_called("Пожарных вызвал, едут", ("112", "101"), named=True)
    assert says_service_called("Мосгаз вызван", ("104",), named=True)
    assert says_service_called("Аварийка выехала", ("105",), named=True)
    assert says_service_called("Механик в пути", ("106",), named=True)
    assert says_service_called("Наряд направлен", ("102",), named=True)


@pytest.mark.parametrize(
    ("text", "key"),
    [
        ("Скорую вызвал уже", "already"),
        ("едут, едут", "already"),
        ("Понял, сейчас вызову", "calling"),
        ("Не вызвал ещё", None),
        ("Доложите обстановку", None),
    ],
)
def test_voice_fallback_for_request_options(text, key):
    options = [{"key": "already", "label": "Уже вызвал, едут"}, {"key": "calling", "label": "x"}]
    assert service_reply_option(options, text) == key
    assert service_reply_option([{"key": "floor_9", "label": "Девятый"}], text) is None


def said(seconds: float, text: str) -> dict:
    return {"at": iso(seconds), "text": text}


# --- Мир ------------------------------------------------------------------------------------


def test_a_called_and_told_resolves_silently_at_firing():
    outcome = resolve_event(
        request_service(), at(0), None, [], [call("103", -40)], at(1), [said(-30, "Скорую вызвал")]
    )
    assert (outcome.branch, outcome.at, outcome.ahead) == ("met", at(0), "told")
    assert outcome.silent
    assert outcome.expectations[0].state == "ahead"


def test_b_called_not_told_asks_then_already_by_option_or_phrase():
    event, calls = request_service(), [call("112", -40)]
    pending = resolve_event(event, at(0), at(2), [], calls, at(10))
    assert pending.branch is None and not pending.silent
    by_option = resolve_event(event, at(0), at(2), [reply(8, "already")], calls, at(10))
    assert (by_option.branch, by_option.at) == ("already", at(8))
    assert by_option.expectations[0].reaction_s == 8
    by_voice = resolve_event(event, at(0), at(2), [], calls, at(10), [said(6, "Уже едут")])
    assert (by_voice.branch, by_voice.at) == ("already", at(6))


def test_b_untold_service_arrives_as_surprise_on_deadline():
    outcome = resolve_event(request_service(), at(0), at(2), [], [call("103", -40)], at(61))
    assert (outcome.branch, outcome.at, outcome.ahead) == ("surprise", at(60), "untold")
    assert outcome.expectations[0].state == "untold"
    # «Уже вызвал» после приезда службы ничего не меняет.
    late = resolve_event(
        request_service(), at(0), at(2), [], [call("103", -40)], None, [said(70, "Уже едут")]
    )
    assert late.branch == "surprise"


def test_b_named_before_without_call_after_ask_still_counts_call_again():
    outcome = resolve_event(
        request_service(), at(0), at(2), [], [call("103", -40), call("103", 20)], at(30)
    )
    assert (outcome.branch, outcome.ahead) == ("met", None)


def test_c_not_called_is_unchanged_and_claim_is_noted():
    outcome = resolve_event(request_service(), at(0), at(2), [reply(5, "already")], [], at(61))
    assert outcome.branch == "missed"
    assert outcome.ahead is None and outcome.claimed


def test_told_before_but_called_after_firing_is_plain_met():
    outcome = resolve_event(
        request_service(), at(0), at(2), [], [call("103", 10)], at(20), [said(-5, "Скорую вызвал")]
    )
    assert (outcome.branch, outcome.ahead) == ("met", None)


def test_ahead_branches_fall_back_to_met_effects():
    event = {
        **request_service(),
        "branches": {"met": {"line": None, "effects": [{"delay": WORKS, "by_s": 5}]}},
    }
    assert effects_of(event, "already") == [{"delay": WORKS, "by_s": 5}]
    assert effects_of(event, "surprise") == [{"delay": WORKS, "by_s": 5}]
    event["branches"]["surprise"] = {"line": None, "effects": []}
    assert effects_of(event, "surprise") == []


# --- Разбор ---------------------------------------------------------------------------------


def evaluate(record: dict, calls: list[dict]):
    ctx = EvalContext(
        {}, {}, [], calls, {"weights": {"brigade_work": 1.0}}, scenario_events=(record,)
    )
    return BrigadeWorkCriterion().evaluate(ctx)


def test_review_called_and_told_is_best_outcome():
    record = {**fired(request_service(), presented=None), "said": [said(-30, "Скорая едет")]}
    result = evaluate(record, [call("103", -40)])
    assert result.score == 1.0
    assert result.evidence == [
        "Расчёт попросил скорую — не понадобилось: служба вызвана заранее и бригада "
        "предупреждена (позвонили в 103 до просьбы бригады). Лучший исход."
    ]
    assert "Служба вызвана заранее и бригада предупреждена — 1." in result.explanation


def test_review_already_answer_after_ask():
    record = fired(request_service(), replies=[reply(7, "already")])
    result = evaluate(record, [call("112", -40)])
    assert result.score == 1.0
    assert result.evidence[0].endswith(
        "на просьбу ответили вариантом, что служба уже едет, через 0:07."
    )


def test_review_untold_is_a_remark_not_an_error():
    result = evaluate(fired(request_service()), [call("103", -40)])
    assert result.score == BRIGADE_UNTOLD_SCORE
    assert not result.critical
    assert "Замечание: не сообщил бригаде, что служба вызвана." in result.evidence[0]
    assert "Замечание: служба вызвана заранее, но бригаде не сказали — 1" in result.explanation
    [remark] = result.remarks
    assert remark.kind == "notice"
    assert remark.text == result.evidence[0]
    assert "сообщите бригаде" in remark.repeat


def test_review_claim_without_call():
    result = evaluate(fired(request_service(), replies=[reply(7, "already")]), [])
    assert result.score == 0.0
    assert result.evidence[0].endswith(
        "в 103 или 112 не позвонили; бригаде сказали, что служба вызвана, но звонка в службу "
        "не было."
    )


def test_stt_full_participle_counts_as_service_news_before_deadline():
    """Точный текст первого STT-ответа стенда не требует повтора до истечения срока."""
    text = "Вызванная скорая помощь"
    options = [
        {"key": "already", "label": "Уже вызвал, едут"},
        {"key": "calling", "label": "Понял, вызываю"},
    ]
    option = service_reply_option(options, text)
    assert option == "already"
    assert says_service_called(text, EXTS, named=True)
    voice = {**reply(149, option), "text": text, "mode": "voice"}
    event = request_service()
    calls = [ended_call("103", 125, 138)]
    outcome = resolve_event(event, at(100), at(102), [voice], calls, at(160))
    assert outcome.branch == "met"
    assert outcome.news == "told"
    assert outcome.news_at == at(149)
    assert outcome.news_by == at(158)
    result = evaluate(fired(event, 100, replies=[voice]), calls)
    assert result.score == 1.0
    assert not result.remarks


@pytest.mark.parametrize(
    "text",
    [
        "Скорая помощь не вызвана",
        "Не вызванная скорая помощь",
        "Скорая пока не вызванная",
        "Вызванная скорая помощь не приедет",
        "Сейчас вызову скорую",
        "Вызываю скорую",
        "Вызову скорую",
    ],
)
def test_stt_full_participle_does_not_turn_denial_or_intent_into_news(text):
    options = [
        {"key": "already", "label": "Уже вызвал, едут"},
        {"key": "calling", "label": "Понял, вызываю"},
    ]
    assert not says_service_called(text, EXTS, named=True)
    assert service_reply_option(options, text) != "already"


@pytest.mark.parametrize("called", [False, True])
def test_stt_full_participle_preserves_missing_call_and_late_news(called):
    """Понятный текст не создаёт звонок и не продлевает прежний срок вести."""
    event = request_service()
    calls = [ended_call("103", 125, 138)] if called else []
    outcome = resolve_event(
        event,
        at(100),
        at(102),
        [],
        calls,
        at(160),
        [said(159, "Вызванная скорая помощь")],
    )
    assert outcome.branch == ("met" if called else "missed")
    assert outcome.news == ("untold" if called else None)
    assert outcome.news_by == (at(158) if called else None)


def test_accepted_at_limits_the_call_ahead():
    record = {**fired(request_service()), "accepted_at": iso(-20)}
    result = evaluate(record, [call("103", -40)])
    assert result.score == 0.0


def test_semantic_local_negation_and_context():
    assert says_service_called("Не пожарных, скорую вызвал", ("103",), named=True)
    assert not says_service_called("Полицию вызвал", ("103",), named=False)
    assert not says_service_called("Скорую вызвали?", ("103",), named=False)
    assert not says_service_called("Скорую вызвал нет еще не вызвал", ("103",), named=False)
    assert says_service_called("Скорую еще не вызвал нет уже вызвал", ("103",), named=True)
