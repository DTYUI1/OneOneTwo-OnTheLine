"""TC-07: смена выглядит живой — фоновые карточки реестра и звонок отдела контроля.

Фоновые карточки — только вид реестра: не `Card`, в оценку, выдачу и остановку занятия не
входят. Отдел контроля звонит только по карточке, которая дольше срока плана осталась без
статуса реагирования; пояснение попадает в учебные сведения карточки, а не в оценку.
"""

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
from app.api.database import create_database_app
from app.api.evaluations.service import evaluation_context
from app.api.sessions.background import LEVEL_COUNTS, background_cards, catalog
from app.core.contracts import validate_json
from app.core.models import Call
from fastapi.testclient import TestClient
from sqlalchemy import select

from . import test_final_scenarios as final
from .test_c04_completion import seed_training
from .test_lifecycle import login, run_db
from .test_practice_gating import worker_tick

# Свой обучаемый: попытки trainee01/04/05 считают тесты прогресса (test_progress.py).
TRAINEE = "trainee03"


def shift_of(database_config, database_url, request, monkeypatch, code: str) -> final.Shift:
    monkeypatch.setitem(final.SEATS, code, (final.SEATS[code][0], TRAINEE))
    return final.open_shift(database_config, database_url, request, code)


def moment(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def training(shift: final.Shift) -> dict[str, Any]:
    body = shift.client.get(f"/api/cards/{shift.card_id}/training").json()
    validate_json(body, "urn:openapi#/components/schemas/CardTraining")
    return dict(body)


def control_calls(url: str, card_id: str) -> list[Call]:
    async def load(db):
        return list(
            await db.scalars(
                select(Call).where(
                    Call.card_id == UUID(card_id),
                    Call.direction == "inbound",
                    Call.brigade_id.is_(None),
                )
            )
        )

    return run_db(url, load)


def outbound_calls(url: str, card_id: str) -> list[str]:
    async def load(db):
        context, *_ = await evaluation_context(db, UUID(card_id))
        return [str(call["id"]) for call in context.calls]

    return run_db(url, load)


@pytest.mark.parametrize("level", [1, 2, 3, 4])
def test_background_count_follows_level(level):
    started = datetime(2026, 10, 17, 9, 0, tzinfo=UTC)
    participant, session = uuid4(), uuid4()
    for service in ("101", "102", "103", "104"):
        cards = background_cards(participant, session, service, level, started)
        assert len(cards) == min(LEVEL_COUNTS[level], len(catalog()[service]))
        assert cards == background_cards(participant, session, service, level, started)
        for item in cards:
            validate_json(item, "urn:openapi#/components/schemas/BackgroundCard")
            assert service in item["source"]["service_ids"]
            assert moment(item["appeared_at"]) < moment(item["status_at"]) < started
            # 103 не отказывает (памятка, с. 23) — и в фоне тоже.
            assert service != "103" or item["state"] == "completed"
        appeared = [moment(item["appeared_at"]) for item in cards]
        assert appeared == sorted(appeared, reverse=True)
        assert len({item["source"]["number"] for item in cards}) == len(cards)
        assert len({item["id"] for item in cards}) == len(cards)
    # Своих фоновых карточек у ЖКХ и Мослифта нет.
    assert background_cards(participant, session, "GKH", level, started) == []


def test_background_cards_stay_out_of_lesson_and_evaluation(
    database_config, database_url, request, monkeypatch
):
    seed_training(database_url)
    shift = shift_of(database_config, database_url, request, monkeypatch, "unwell-street-103-2")
    session_id = shift.card["session_id"]
    path = f"/api/sessions/{session_id}/background-cards"
    background = shift.client.get(path).json()
    assert len(background) == LEVEL_COUNTS[shift.data["level"]] == 3
    assert background == shift.client.get(path).json()
    session = shift.client.get(f"/api/sessions/{session_id}").json()
    for item in background:
        validate_json(item, "urn:openapi#/components/schemas/BackgroundCard")
        assert item["session_id"] == session_id
        assert moment(item["status_at"]) < moment(session["started_at"])
        # Не Card: ни открыть, ни действовать по ней нельзя.
        assert shift.client.get(f"/api/cards/{item['id']}").status_code == 404
    numbers = {item["source"]["number"] for item in background}
    assert shift.card["source"]["number"] not in numbers
    own = [c for c in shift.client.get("/api/cards").json() if c["session_id"] == session_id]
    assert [c["id"] for c in own] == [shift.card_id]
    lifecycle = shift.client.get(f"/api/sessions/{session_id}/lifecycle").json()
    assert lifecycle["remaining_assignments"] == 1

    # Чужому — нет: преподавателю операция не положена, другой обучаемый не участник.
    with TestClient(create_database_app(database_config)) as other:
        login(other)
        assert other.get(path).status_code == 403
        login(other, "trainee01")
        assert other.get(path).status_code == 404

    # Карточка по эталону закрывается с чистым разбором: фон оценку не задевает.
    final.play(shift)
    evaluation = shift.evaluation()
    assert final.clean(evaluation) == {}
    lifecycle = shift.client.get(f"/api/sessions/{session_id}/lifecycle").json()
    assert lifecycle["remaining_assignments"] == 0
    assert shift.client.get(path).json() == background


def test_control_does_not_call_when_status_is_in_time(
    database_config, database_url, request, monkeypatch
):
    seed_training(database_url)
    shift = shift_of(database_config, database_url, request, monkeypatch, "gas-entrance-104-2")
    after_s = shift.data["control_call"]["after_s"]
    appeared = moment(shift.card["appeared_at"])
    shift.open()
    worker_tick(database_url, appeared + timedelta(seconds=after_s - 5))
    assert training(shift)["control"] is None
    shift.accept()
    # Статус поставлен до срока — звонка не будет и после него.
    worker_tick(database_url, appeared + timedelta(seconds=after_s + 30))
    assert training(shift)["control"] is None
    assert control_calls(database_url, shift.card_id) == []


def test_control_calls_once_when_card_hangs_without_status(
    database_config, database_url, request, monkeypatch
):
    seed_training(database_url)
    shift = shift_of(database_config, database_url, request, monkeypatch, "unwell-street-103-2")
    plan = shift.data["control_call"]
    after_s = plan["after_s"]
    appeared = moment(shift.card["appeared_at"])
    shift.open()
    worker_tick(database_url, appeared + timedelta(seconds=after_s + 1))
    body = training(shift)
    ring = body["control"]
    assert ring["answered_at"] is None and ring["ended_at"] is None and ring["reply"] is None
    assert after_s <= ring["without_status_s"] <= after_s + 2
    assert ring["reply_options"] == plan["reply_options"]
    # Вызов бригады — не он: incoming и callbacks — только о бригадах.
    assert body["incoming"] == [] and body["callbacks"] == []
    call = shift.client.get(f"/api/calls/{ring['call_id']}").json()
    assert (call["direction"], call["phone_ext"], call["state"]) == ("inbound", "112", "ringing")
    worker_tick(database_url, appeared + timedelta(seconds=after_s + 3))
    assert len(control_calls(database_url, shift.card_id)) == 1

    call_id = ring["call_id"]
    option = plan["reply_options"][0]
    reply = {"call_id": call_id, "mode": "parts", "text": option["label"]}
    # До ответа пояснять некому; чужой звонок и чужой вариант не принимаются.
    shift.send("control_reply", {**reply, "option_key": option["key"]}, expected=409)
    shift.send("call_answer", {"call_id": call_id})
    shift.send("control_reply", {**reply, "option_key": "nope"}, expected=409)
    shift.send(
        "control_reply", {"call_id": str(uuid4()), "mode": "voice", "text": "Сбой"}, expected=404
    )
    shift.send("control_reply", {**reply, "option_key": option["key"]})
    shift.send("call_hangup", {"call_id": call_id})
    done = training(shift)["control"]
    assert done["reply"]["mode"] == "parts"
    assert (done["reply"]["option_key"], done["reply"]["text"]) == (option["key"], option["label"])
    assert done["answered_at"] is not None and done["ended_at"] is not None
    assert done["end_reason"] is None

    # Статус после звонка ничего не меняет: второго звонка нет. В оценку вызов не идёт.
    shift.accept()
    worker_tick(database_url, appeared + timedelta(seconds=after_s * 3))
    assert len(control_calls(database_url, shift.card_id)) == 1
    assert call_id not in outbound_calls(database_url, shift.card_id)


def test_control_call_without_answer_becomes_missed(
    database_config, database_url, request, monkeypatch
):
    seed_training(database_url)
    shift = shift_of(database_config, database_url, request, monkeypatch, "traffic-blocked-102-2")
    after_s = shift.data["control_call"]["after_s"]
    appeared = moment(shift.card["appeared_at"])
    # Карточку даже не открыли: «висит» и без «Получена службой».
    worker_tick(database_url, appeared + timedelta(seconds=after_s + 1))
    ring = training(shift)["control"]
    assert ring is not None and ring["ended_at"] is None
    worker_tick(database_url, appeared + timedelta(seconds=after_s + 27))
    missed = training(shift)["control"]
    assert (missed["end_reason"], missed["answered_at"]) == ("missed", None)
    shift.send("call_answer", {"call_id": ring["call_id"]}, expected=409)
    worker_tick(database_url, appeared + timedelta(seconds=after_s * 4))
    assert len(control_calls(database_url, shift.card_id)) == 1
