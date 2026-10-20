"""Нормативные примеры и совместимость голосовых/ручных ответов."""

import json
from pathlib import Path

import pytest
from evalcore import service_told


@pytest.mark.parametrize(
    "row",
    json.loads(
        (Path(__file__).parents[1] / "evalcore" / "service_language_corpus.json").read_text()
    )["cases"],
)
def test_normative_language(row):
    parsed = service_told.parse_service_intent(row["text"], row["exts"])
    assert parsed["called"] is row["called"], row
    assert parsed["option"] == row["option"], row
    assert parsed["services"] == row["services"], row
    assert (
        service_told.says_service_called(row["text"], row["exts"], named=row["named"])
        is row["named_called"]
    ), row
    options = [{"key": "already"}, {"key": "calling"}]
    assert service_told.service_reply_option(options, row["text"], row["exts"]) == row["option"]


@pytest.mark.parametrize(
    ("reply", "expected"),
    [
        ({"option_key": "already"}, True),
        ({"option_key": "already", "mode": "manual", "text": "Скорую не вызвал"}, True),
        ({"option_key": "already", "mode": "voice"}, True),
        ({"option_key": "already", "mode": "voice", "text": "Полицию вызвал"}, False),
        ({"option_key": "already", "mode": "voice", "text": "Скорую вызвали?"}, False),
        ({"option_key": "already", "mode": "voice", "text": "Скорую вызвал"}, True),
        ({"option_key": "calling", "mode": "voice", "text": "Медики едут"}, True),
    ],
)
def test_reply_semantics(reply, expected):
    assert service_told.reply_says_service_called(reply, ("103", "112")) is expected
