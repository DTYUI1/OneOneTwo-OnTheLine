"""GP-05 с БД: направить бригаду = разговор с ней. Без вводной бригада не выезжает; вводная
голосом и по частям — бригада повторяет адрес и выезжает; неверный адрес — едет туда, доклад
о прибытии «не туда», в разборе критическая ошибка адреса."""

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from app.api.database import create_database_app
from app.api.evaluations.service import evaluation_context
from app.api.training import briefing
from app.core.contracts import validate_json
from app.core.models import BrigadeBriefing
from app.seed.scenarios import file_scenario_id
from evalcore.criteria import AddressCriterion
from fastapi.testclient import TestClient
from sqlalchemy import select

from . import test_c03_sessions as c03
from .briefing_helpers import briefing_payload
from .test_c04_completion import seed_training
from .test_lifecycle import login, run_db
from .test_live_brigade_flow import present, training
from .test_practice_gating import deliveries, send, worker_tick

TRAINEE = "trainee03"
GAS = "gas-apartment-101-1"  # улица Плеханова, дом 11; ловушки повтора адреса нет
SMOKE = "smoke-apartment-101-1"  # Бескудниковский бульвар, 24; ловушка readback_error


@pytest.fixture
def briefing_card(database_config, database_url, request):
    """Занятие преподавателя со сценарием `request.param`: карточка обучаемого принята."""
    seed_training(database_url)
    code = request.param
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client)
        users = {u["login"]: u for u in client.get("/api/users").json()}
        scenario = client.get(f"/api/scenarios/{file_scenario_id(code)}").json()
        created = client.post(
            "/api/sessions",
            headers=headers,
            json={
                "title": "Вводная бригаде",
                "participants": [
                    {
                        "user_id": users[TRAINEE]["id"],
                        "workstation_number": 3,
                        "dds_service_id": "101",
                        "level": 1,
                    }
                ],
                "settings_snapshot": client.get("/api/settings").json(),
            },
        )
        assert created.status_code == 201, created.text
        session_id = created.json()["id"]

        def finish() -> None:
            with TestClient(create_database_app(database_config)) as teacher:
                teacher.post(
                    f"/api/sessions/{session_id}/finish",
                    json={"contract_version": 2, "request_id": str(uuid4())},
                    headers=login(teacher),
                )

        request.addfinalizer(finish)
        item = {
            "participant_id": users[TRAINEE]["id"],
            "scenario_id": scenario["id"],
            "scenario_version": scenario["version"],
            "order": 1,
            "delay_from_start_s": 0,
            "delivery_mode": "profile",
        }
        response = client.post(
            f"/api/sessions/{session_id}/assignments/batch",
            json={"request_id": str(uuid4()), "items": [item]},
            headers=headers,
        )
        assert response.status_code == 201, response.text
        assert client.post(f"/api/sessions/{session_id}/start", headers=headers).status_code == 200
        assert c03.tick(database_url) >= 1
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, TRAINEE)
        card = next(c for c in client.get("/api/cards").json() if c["session_id"] == session_id)
        brigade_id = training(client, card["id"])["available_brigade_ids"][0]
        target = next(
            t
            for t in client.get("/api/services/101/call-targets").json()
            if t["brigade_id"] == brigade_id
        )
        send(client, headers, card["id"], "deliver", {})
        yield client, headers, card, target


def dial(client, headers, card, target) -> str:
    call_id = str(uuid4())
    send(
        client,
        headers,
        card["id"],
        "call_dial_target",
        {"call_id": call_id, "call_target_id": target["id"], "brigade_id": target["brigade_id"]},
    )
    send(client, headers, card["id"], "call_answer", {"call_id": call_id})
    return call_id


def check(client, headers, call_id, text, expected=200):
    response = client.post(
        f"/api/calls/{call_id}/briefing-check", json={"text": text}, headers=headers
    )
    assert response.status_code == expected, response.text
    if expected == 200:
        validate_json(response.json(), "urn:openapi#/components/schemas/BriefingCheck")
    return response.json()


def accept(client, headers, card) -> None:
    send(client, headers, card["id"], "status_change", {"state": "accepted", "comment": "Принята"})


@pytest.mark.parametrize("briefing_card", [GAS], indirect=True)
def test_without_briefing_brigade_does_not_leave(briefing_card, database_url):
    client, headers, card, target = briefing_card
    # До «Принята» бригада отказывает, и вводную в этом разговоре дать нельзя.
    early = dial(client, headers, card, target)
    payload = briefing_payload(card, early)
    check(client, headers, early, payload["text"], 409)
    send(client, headers, card["id"], "brigade_briefing", payload, 409)
    send(client, headers, card["id"], "call_hangup", {"call_id": early})

    accept(client, headers, card)
    call_id = dial(client, headers, card, target)
    # Неполная вводная: бригада переспрашивает и не выезжает.
    partial = check(client, headers, call_id, "Запах газа в квартире")
    assert partial["complete"] is False and partial["address"] == "missing"
    assert partial["readback"] is None
    assert partial["ask_again"] == briefing.ASK_AGAIN["101"]["address"]
    send(
        client,
        headers,
        card["id"],
        "brigade_briefing",
        {"call_id": call_id, "mode": "voice", "text": "Запах газа в квартире"},
    )
    assert worker_tick(database_url, datetime.now(UTC) + timedelta(seconds=120)) == 0
    assert deliveries(database_url, UUID(card["id"])) == 0
    assert training(client, card["id"])["selected_brigade_ids"] == []
    blocked = send(
        client,
        headers,
        card["id"],
        "status_change",
        {"state": "responding", "comment": "Выехали"},
        409,
    )
    assert blocked.json()["message"] == (
        "Статус «Начало реагирования» пока недоступен: бригада не выехала. "
        "Позвоните бригаде и дайте вводную: адрес и что случилось."
    )
    send(client, headers, card["id"], "call_hangup", {"call_id": call_id})
    # После отбоя вводную в этом звонке не дать.
    send(client, headers, card["id"], "brigade_briefing", briefing_payload(card, call_id), 409)


@pytest.mark.parametrize(
    ("briefing_card", "mode", "text"),
    [
        (GAS, "voice", "Улица Плеханова, дом одиннадцать, запах газа в квартире"),
        (GAS, "parts", None),
    ],
    indirect=["briefing_card"],
)
def test_briefing_by_voice_or_parts_sends_brigade(briefing_card, database_url, mode, text):
    client, headers, card, target = briefing_card
    accept(client, headers, card)
    call_id = dial(client, headers, card, target)
    payload = {**briefing_payload(card, call_id, mode), **({"text": text} if text else {})}
    result = check(client, headers, call_id, payload["text"])
    assert result == {
        "address": "ok",
        "heard_address": "улица Плеханова, 11",
        "incident": True,
        "complete": True,
        "readback": "Повторяю: улица Плеханова, 11.",
        "ask_again": None,
    }
    send(client, headers, card["id"], "brigade_briefing", payload)
    # Бригада направлена сюда и сразу, в этом же разговоре, докладывает о выезде.
    view = training(client, card["id"])
    assert view["selected_brigade_ids"] == [target["brigade_id"]]
    (departure,) = view["messages"]
    assert departure["delivery"]["call_id"] == call_id
    present(client, headers, card["id"], departure)
    send(client, headers, card["id"], "status_change", {"state": "responding", "comment": "Выезд"})

    async def stored(db):
        row = await db.scalar(select(BrigadeBriefing).where(BrigadeBriefing.call_id == call_id))
        return row.mode, row.address, row.complete

    assert run_db(database_url, stored) == (mode, "ok", True)


@pytest.mark.parametrize("briefing_card", [GAS], indirect=True)
def test_wrong_address_brigade_arrives_elsewhere(briefing_card, database_url):
    client, headers, card, target = briefing_card
    accept(client, headers, card)
    call_id = dial(client, headers, card, target)
    text = "Улица Плеханова, дом семнадцать, запах газа в квартире"
    result = check(client, headers, call_id, text)
    assert result["address"] == "wrong" and result["complete"] is True
    # Адреса «Плеханова, 17» нет среди записанных повторов (верный и похожие ошибки вариантов
    # по частям): без голоса бригада не говорит — сразу доклад о выезде (проверка 17.10).
    assert result["readback"] is None
    send(
        client,
        headers,
        card["id"],
        "brigade_briefing",
        {"call_id": call_id, "mode": "voice", "text": text},
    )
    (departure,) = training(client, card["id"])["messages"]
    present(client, headers, card["id"], departure)
    send(client, headers, card["id"], "status_change", {"state": "responding", "comment": "Выезд"})

    # Доклад о прибытии — «не туда» и позже: вместо 6 с плана — через 40 с ожидания, не дальше
    # (WRONG_ADDRESS_DELAY обрезан паузой между докладами, gating.MAX_REPORT_WAIT, GP-12).
    now = datetime.now(UTC)
    worker_tick(database_url, now + timedelta(seconds=30))
    assert deliveries(database_url, UUID(card["id"])) == 1
    worker_tick(database_url, now + timedelta(seconds=41))
    arrival = training(client, card["id"])["messages"][-1]["delivery"]["message"]
    # «Переехали по карточке» — фраза банка службы со своей записью, без адресов.
    assert arrival["text"] == briefing.MOVED_TEXT
    assert arrival["audio"] is not None

    async def address(db):
        context, *_ = await evaluation_context(db, UUID(card["id"]))
        return AddressCriterion().evaluate(context)

    verdict = run_db(database_url, address)
    assert verdict.critical and verdict.score == 0
    assert verdict.explanation.startswith(
        "Критическая ошибка: во вводной бригаде назван адрес «улица Плеханова, 17» вместо "
        "«улица Плеханова, 11» — бригада уехала не туда."
    )


@pytest.mark.parametrize("briefing_card", [SMOKE], indirect=True)
def test_readback_trap_repeats_address_itself(briefing_card):
    """Ловушка повтора адреса: верный адрес бригада не повторяет — это сделает событие."""
    client, headers, card, target = briefing_card
    accept(client, headers, card)
    call_id = dial(client, headers, card, target)
    right = check(client, headers, call_id, briefing_payload(card, call_id)["text"])
    assert right["complete"] is True and right["readback"] is None
    wrong = check(client, headers, call_id, "Бескудниковский переулок, 24, задымление в квартире")
    assert wrong["address"] == "wrong"
    # Такого повтора нет в записях — бригада молчит до доклада о выезде.
    assert wrong["readback"] is None
