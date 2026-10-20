"""Один смысл голосового ответа для ветки мира и оценки работы с бригадой."""

import pytest
from evalcore.brigade import BrigadeWorkCriterion, resolve_event
from evalcore.models import EvalContext

from .test_brigade_work import at, ended_call, fired, iso, reply, request_service


@pytest.mark.parametrize(
    ("text", "news"),
    [
        ("Вызванная скорая помощь", "told"),
        ("Медики уже едут", "told"),
        ("Вызов приняли, машина в пути", "told"),
        ("Не пожарных, скорую вызвал", "told"),
        ("Полицию вызвал", "untold"),
        ("Скорую уже вызвали?", "untold"),
        ("Не удалось вызвать скорую", "untold"),
        ("Скорую не вызвал", "untold"),
        ("Сейчас вызову скорую", "untold"),
    ],
)
def test_voice_option_key_cannot_override_the_meaning_of_service_news(text, news):
    """Ключ already не превращает вопрос, отрицание или другую службу в верную весть."""
    event = request_service()
    voice = {**reply(145, "already"), "mode": "voice", "text": text}
    calls = [ended_call("103", 125, 138)]
    result = resolve_event(event, at(100), at(102), [voice], calls, at(160))
    assert result.branch == "met"
    assert result.news == news
    record = fired(event, 100, replies=[voice])
    ctx = EvalContext(
        {}, {}, [], calls, {"weights": {"brigade_work": 1.0}}, scenario_events=(record,)
    )
    score = BrigadeWorkCriterion().evaluate(ctx)
    if news == "told":
        assert score.score == 1.0
        assert not score.remarks
    else:
        assert any("не сообщили" in evidence for evidence in score.evidence)


def test_manual_already_option_without_transcription_remains_a_valid_reply():
    event = request_service()
    result = resolve_event(
        event,
        at(100),
        at(102),
        [reply(145, "already")],
        [ended_call("103", 125, 138)],
        at(160),
    )
    assert result.news == "told"
    assert result.news_at == at(145)


@pytest.mark.parametrize("at_seconds", [158, 158.001])
def test_service_intent_keeps_the_inclusive_deadline(at_seconds):
    result = resolve_event(
        request_service(),
        at(100),
        at(102),
        [],
        [ended_call("103", 125, 138)],
        at(160),
        [{"at": iso(at_seconds), "text": "Медики уже едут"}],
    )
    assert result.news == ("told" if at_seconds == 158 else "untold")
    assert result.news_by == at(158)


def test_service_intent_does_not_create_a_call():
    result = resolve_event(
        request_service(),
        at(100),
        at(102),
        [],
        [],
        at(160),
        [{"at": iso(145), "text": "Медики уже едут"}],
    )
    assert result.branch == "missed"
    assert result.news is None
