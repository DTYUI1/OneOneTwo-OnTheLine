"""GP-26: статус без доклада, который сервер не принял, виден в журнале и в разборе.

Эталон — docs/dds_gameplay.md, раздел 7: «Статус без доклада — сервер не принимает, причина в
строке; в разборе — Последовательность статусов; не критично». Отказ (409 report_required)
пишется в журнал карточки записью `status_denied` (contracts/C01_INTERFACES.md, I-BRIGADE),
разбор называет её строкой критерия status_flow, балл не снижается.
"""

from datetime import UTC, datetime
from uuid import UUID, uuid4, uuid5

from app.api.database import create_database_app
from app.core.models import CardEvent
from fastapi.testclient import TestClient
from sqlalchemy import select

from .test_c04_completion import seed_training
from .test_final_scenarios import Shift, clean, explanation, open_shift, play
from .test_lifecycle import login, run_db

CODE = "traffic-blocked-102-2"
LINE = "Не принят сервером: «Прибытие» — не было доклада бригады о прибытии"


def denied_rows(shift: Shift) -> list[CardEvent]:
    async def load(db):
        return list(
            (
                await db.scalars(
                    select(CardEvent).where(
                        CardEvent.card_id == UUID(shift.card_id),
                        CardEvent.type == "status_denied",
                    )
                )
            ).all()
        )

    return run_db(shift.url, load)


def test_denied_status_is_in_journal_and_review(database_config, database_url, request):
    seed_training(database_url)
    shift = open_shift(database_config, database_url, request, CODE)
    attempt = {
        "client_event_id": str(uuid4()),
        "client_ts": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "type": "status_change",
        "payload": {"state": "arrived", "comment": "Прибыли."},
    }
    refusals = []
    plain_status = shift.status

    def status(state: str, comment: str, expected: int = 200) -> None:
        plain_status(state, comment, expected)
        if state != "responding" or refusals:
            return
        # «Прибытие» сразу после выезда: доклада о прибытии ещё не было (раздел 7).
        for _ in range(2):  # повтор того же события — вторую запись не создаёт
            response = shift.client.post(
                f"/api/cards/{shift.card_id}/events", json=attempt, headers=shift.headers
            )
            assert response.status_code == 409, response.text
            refusals.append(response.json())

    shift.status = status  # type: ignore[method-assign]
    play(shift)

    assert [item["code"] for item in refusals] == ["report_required"] * 2
    rows = denied_rows(shift)
    assert len(rows) == 1, rows
    assert rows[0].payload == {
        "state": "arrived",
        "code": "report_required",
        "message": refusals[0]["message"],
        "denied_event_id": attempt["client_event_id"],
    }
    assert rows[0].client_event_id == uuid5(UUID(attempt["client_event_id"]), "status_denied")

    # Лента преподавателя (реплей) читает журнал карточки.
    with TestClient(create_database_app(database_config)) as teacher:
        login(teacher)
        events = teacher.get(f"/api/cards/{shift.card_id}/events")
        assert events.status_code == 200, events.text
        denied = [e for e in events.json() if e["type"] == "status_denied"]
        assert [e["payload"]["state"] for e in denied] == ["arrived"]

    evaluation = shift.evaluation()
    # Не критично и без снижения балла сверх эталона: эталонный путь остаётся чистым.
    assert clean(evaluation) == {}
    lines = explanation(evaluation, "status_flow")
    assert LINE in lines[1:], lines
    assert "Статус без доклада сервер не принял: «Прибытие»" in lines[0], lines


def test_client_cannot_write_denied_status(database_config, database_url, request):
    seed_training(database_url)
    shift = open_shift(database_config, database_url, request, CODE)
    shift.open()
    response = shift.client.post(
        f"/api/cards/{shift.card_id}/events",
        json={
            "client_event_id": str(uuid4()),
            "client_ts": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "type": "status_denied",
            "payload": {
                "state": "arrived",
                "code": "report_required",
                "message": "",
                "denied_event_id": str(uuid4()),
            },
        },
        headers=shift.headers,
    )
    assert response.status_code == 422, response.text
    assert denied_rows(shift) == []


def test_other_refusals_are_not_journaled(database_config, database_url, request):
    """Недопустимый переход — не статус без доклада: записи нет."""
    seed_training(database_url)
    shift = open_shift(database_config, database_url, request, CODE)
    shift.open()
    shift.status("completed", "Работы завершены.", expected=409)
    assert denied_rows(shift) == []
