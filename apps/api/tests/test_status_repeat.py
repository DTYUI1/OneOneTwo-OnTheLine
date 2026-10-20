"""Двойной щелчок по «Подтвердить» (TC-08): то же действие новым client_event_id — одно событие."""

from app.core.models import CardEvent
from sqlalchemy import func, select

from .test_c01_v3_statuses import trainee_card  # noqa: F401
from .test_c03_sessions import lesson  # noqa: F401
from .test_lifecycle import run_db


def count_events(database_url, card_id, kind):
    async def count(db):
        return await db.scalar(
            select(func.count())
            .select_from(CardEvent)
            .where(CardEvent.card_id == card_id, CardEvent.type == kind)
        )

    return run_db(database_url, count)


def test_double_status_click_is_one_event(trainee_card, database_url):  # noqa: F811
    card, send = trainee_card
    body = {"state": "accepted", "comment": "Принято, вызов взят в работу"}
    first = send("status_change", body)
    assert first["duplicate"] is False
    assert first["card"]["state"] == "accepted"
    # Второй щелчок: другой client_event_id, то же тело — повтор, а не отказ.
    second = send("status_change", body)
    assert second["duplicate"] is True
    assert second["card"]["state"] == "accepted"
    assert second["server_ts"] == first["server_ts"]
    assert count_events(database_url, card["id"], "status_change") == 1
    # Повтор, пришедший позже, распознаётся так же, а следующий статус по-прежнему ставится.
    assert send("status_change", body)["duplicate"] is True
    assert send("status_change", {"state": "responding", "comment": "Выехали"})["card"][
        "state"
    ] == ("responding")
    assert count_events(database_url, card["id"], "status_change") == 2


def test_repeat_with_another_comment_is_not_swallowed(trainee_card, database_url):  # noqa: F811
    card, send = trainee_card
    send("status_change", {"state": "accepted", "comment": "Принято"})
    # Другой комментарий — это новое действие: молча терять его нельзя, остаётся прежний 409.
    send("status_change", {"state": "accepted", "comment": "Принято, дополнено"}, expected=409)
    assert count_events(database_url, card["id"], "status_change") == 1


def test_redirect_double_click_is_one_event(trainee_card, database_url):  # noqa: F811
    card, send = trainee_card
    send("status_change", {"state": "rejected", "comment": "Не наша зона, передано в 101"})
    body = {"service_id": "101", "comment": "Передано в 101: пожар"}
    assert send("redirect", body)["duplicate"] is False
    assert send("redirect", body)["duplicate"] is True
    send("redirect", {"service_id": "101", "comment": "Иначе"}, expected=409)
    assert count_events(database_url, card["id"], "redirect") == 1
