"""Прямой старый потребитель использует канонический смысл, сохраняя окно звонка."""

from app.tools.coherence import phone


def test_phone_helpers_use_canonical_intent():
    assert phone.says_called("Медики уже едут")
    assert not phone.says_called("Скорую уже вызвали?")
    assert not phone.says_called("Сейчас вызову скорую")
    assert phone.called_service("Не пожарных, скорую вызвал") == "103"
    assert phone.called_service("Слесари выехали") == "GKH"
    assert phone.called_service("Лифтовые механики направлены") == "MOSLIFT"


def test_phone_news_preserves_real_call_and_window():
    text = "Медики уже едут"
    assert phone.news_service(text, phone.Awaited("103", True, ("103",), ("103",))) == "103"
    assert phone.news_service(text, phone.Awaited("103", False, ("103",), ())) is None
    assert phone.news_service(text, phone.Awaited(None, False, (), ())) is None
    assert phone.news_service(text, phone.Awaited(None, False, (), (), ("112",))) == "103"


def test_existing_world_lexicon_keeps_medical_qualifier_out_of_police():
    from app.seed.world_lexicon import service_mentions

    assert not service_mentions("Участковый врач на месте", "101")
    assert any(item.ext == "102" for item in service_mentions("Участковый на месте", "101"))
