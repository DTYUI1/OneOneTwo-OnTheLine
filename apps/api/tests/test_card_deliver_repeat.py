"""Повтор deliver новым client_event_id: стабильный код, чтобы клиент не блокировал карточку."""

from .test_c01_v3_statuses import trainee_card  # noqa: F401
from .test_c03_sessions import lesson  # noqa: F401


def test_repeated_deliver_returns_stable_conflict_code(trainee_card):  # noqa: F811
    _, send = trainee_card
    response = send("deliver", {}, expected=409)
    assert response["code"] == "card_already_delivered"
    # Карточка не заблокирована: дальнейшие действия принимаются.
    assert send("status_change", {"state": "accepted", "comment": "Принято"})["card"]["state"] == (
        "accepted"
    )
