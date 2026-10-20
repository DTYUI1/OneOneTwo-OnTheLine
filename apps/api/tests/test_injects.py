"""Вводные преподавателя (DT-06, #69): событие плана, поданное вручную в идущее занятие.

«Задымление в квартире», 101, полный цикл: тревога расчёта — только вводной
(`trigger.on = inject`, `requires_state = arrived`). Преподаватель подаёт её, когда расчёт
на месте; бригада звонит обучаемому тревожным вызовом, в разборе — «Вводная преподавателя».
"""

import time
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from app.api.database import create_database_app
from app.api.training.scenario_events import evaluation_events
from app.core.contracts import validate_json
from app.core.models import Call, Card, ScenarioEventFiring
from app.seed.scenarios import file_scenario_id
from evalcore.brigade import BrigadeWorkCriterion
from evalcore.models import EvalContext
from fastapi.testclient import TestClient
from sqlalchemy import select, update

from . import test_c03_sessions as c03
from .briefing_helpers import briefing_payload
from .test_c04_completion import seed_training
from .test_lifecycle import login, run_db
from .test_live_brigade_flow import present, training
from .test_practice_gating import send, worker_tick

TRAINEE = "trainee02"  # ДДС 101
SCENARIO = file_scenario_id("smoke-apartment-101-1")


def injects(client, session_id, body=None, headers=None):
    if body is None:
        response = client.get(f"/api/sessions/{session_id}/injects")
        validate_json(response.json(), "urn:openapi#/components/schemas/InjectOverview")
        return response
    return client.post(f"/api/sessions/{session_id}/injects", json=body, headers=headers)


def test_teacher_injects_alarm_when_crew_on_scene(database_config, database_url, request):
    seed_training(database_url)
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client)
        users = {u["login"]: u for u in client.get("/api/users").json()}
        trainee = users[TRAINEE]["id"]
        scenario = client.get(f"/api/scenarios/{SCENARIO}").json()
        settings = client.get("/api/settings").json()
        created = client.post(
            "/api/sessions",
            headers=headers,
            json={
                "title": "Вводные",
                "participants": [
                    {
                        "user_id": trainee,
                        "workstation_number": 2,
                        "dds_service_id": "101",
                        "level": 1,
                    }
                ],
                "settings_snapshot": settings,
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
        # Занятие ещё не идёт — вводную подать нельзя.
        early = injects(client, session_id, {"kind": "alarm", "targets": "all"}, headers)
        assert early.status_code == 409, early.text
        batch = {
            "request_id": str(uuid4()),
            "items": [
                {
                    "participant_id": trainee,
                    "scenario_id": str(SCENARIO),
                    "scenario_version": scenario["version"],
                    "order": 1,
                    "delay_from_start_s": 0,
                    "delivery_mode": "profile",
                }
            ],
        }
        response = client.post(
            f"/api/sessions/{session_id}/assignments/batch", json=batch, headers=headers
        )
        assert response.status_code == 201, response.text
        assert client.post(f"/api/sessions/{session_id}/start", headers=headers).status_code == 200
        assert c03.tick(database_url) >= 1

        # Меню преподавателя: тревогу примет одна карточка; поданных ещё нет.
        overview = injects(client, session_id).json()
        assert {"kind": "alarm", "title": "Тревога бригады", "cards": 1} in overview["options"]
        assert overview["fired"] == []
        # Бригада ещё не выехала — неприменимо, с причиной для преподавателя.
        receipt = injects(client, session_id, {"kind": "alarm", "targets": [trainee]}, headers)
        assert receipt.status_code == 201, receipt.text
        validate_json(receipt.json(), "urn:openapi#/components/schemas/InjectReceipt")
        [result] = receipt.json()["results"]
        assert result["status"] == "not_applicable"
        assert result["workstation"] == 2
        assert "Бригада ещё не выехала" in result["reason"]
        # Вида, которого в сценарии нет как вводной, — тоже ответ по месту, не ошибка.
        [other] = injects(
            client, session_id, {"kind": "silence", "targets": "all"}, headers
        ).json()["results"]
        assert other["status"] == "not_applicable"
        # Адресат не из занятия — 422.
        stranger = {"kind": "alarm", "targets": [users["trainee05"]["id"]]}
        assert injects(client, session_id, stranger, headers).status_code == 422

    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, TRAINEE)
        # Обучаемый вводные не подаёт и не видит.
        assert injects_status(client, session_id, headers) == (403, 403)
        card = next(c for c in client.get("/api/cards").json() if c["session_id"] == session_id)
        card_id = card["id"]
        brigade_id = training(client, card_id)["available_brigade_ids"][0]
        target = next(
            t
            for t in client.get("/api/services/101/call-targets").json()
            if t["brigade_id"] == brigade_id
        )
        send(client, headers, card_id, "deliver", {})
        send(client, headers, card_id, "status_change", {"state": "accepted", "comment": "Принята"})
        send(client, headers, card_id, "brigades_select", {"brigade_ids": [brigade_id]})
        call_id = str(uuid4())
        send(
            client,
            headers,
            card_id,
            "call_dial_target",
            {"call_id": call_id, "call_target_id": target["id"], "brigade_id": brigade_id},
        )
        send(client, headers, card_id, "call_answer", {"call_id": call_id})
        send(client, headers, card_id, "brigade_briefing", briefing_payload(card, call_id))

        def step(state: str, comment: str) -> None:
            worker_tick(database_url, datetime.now(UTC) + timedelta(seconds=10))
            item = next(
                m for m in training(client, card_id)["messages"] if m["state"] != "presented"
            )
            present(client, headers, card_id, item)
            send(client, headers, card_id, "status_change", {"state": state, "comment": comment})

        step("responding", "Расчёт выехал")
        # Повтор адреса с ошибкой (событие плана DT-10) — поправляем, как в живой бригаде.
        worker_tick(database_url, datetime.now(UTC) + timedelta(seconds=5))
        readback = next(
            m for m in training(client, card_id)["messages"] if "reply_options" in m["delivery"]
        )
        present(client, headers, card_id, readback)
        time.sleep(1.1)
        send(
            client,
            headers,
            card_id,
            "brigade_reply",
            {
                "call_id": call_id,
                "delivery_id": readback["delivery"]["delivery_id"],
                "option_key": "fix",
            },
        )
        answer = next(
            m
            for m in training(client, card_id)["messages"]
            if m["delivery"]["message"]["text"] == "Принял поправку, перестраиваем маршрут."
        )
        present(client, headers, card_id, answer)
        step("arrived", "Расчёт на месте")
        send(client, headers, card_id, "call_hangup", {"call_id": call_id})

    with TestClient(create_database_app(database_config)) as client:
        headers = login(client)
        # Решение 15.10: тревога не дописывается в только что законченный разговор —
        # бригада звонит не раньше чем через 10 с после отбоя.
        receipt = injects(client, session_id, {"kind": "alarm", "targets": "all"}, headers)
        [result] = receipt.json()["results"]
        assert result["status"] == "not_applicable", result
        assert "только что закончился" in result["reason"]

    async def hung_up_earlier(db):
        await db.execute(
            update(Call)
            .where(Call.card_id == UUID(card_id))
            .values(ended_at=Call.ended_at - timedelta(seconds=11))
        )

    run_db(database_url, hung_up_earlier)

    with TestClient(create_database_app(database_config)) as client:
        headers = login(client)
        receipt = injects(client, session_id, {"kind": "alarm", "targets": "all"}, headers)
        assert receipt.status_code == 201, receipt.text
        [result] = receipt.json()["results"]
        assert result["status"] == "fired", result
        assert result["card_id"] == card_id
        assert result["reason"] is None
        # Второй раз то же событие на карточке не срабатывает.
        [again] = injects(client, session_id, {"kind": "alarm", "targets": "all"}, headers).json()[
            "results"
        ]
        assert again["status"] == "not_applicable"
        assert "уже было" in again["reason"]
        overview = injects(client, session_id).json()
        assert [item["kind"] for item in overview["fired"]] == ["alarm"]
        assert overview["fired"][0]["workstation"] == 2
        assert overview["fired"][0]["card_number"] == card["source"]["number"]
        assert all(option["kind"] != "alarm" for option in overview["options"])

    with TestClient(create_database_app(database_config)) as client:
        login(client, TRAINEE)
        # Бригада звонит сама тревожным вызовом — сразу, без тика worker.
        incoming = training(client, card_id)["incoming"]
        assert [item["priority"] for item in incoming] == ["alarm"]

    async def review(db):
        card_row = await db.get(Card, UUID(card_id))
        fired = list(
            await db.scalars(
                select(ScenarioEventFiring)
                .where(ScenarioEventFiring.card_id == card_row.id)
                .order_by(ScenarioEventFiring.fired_at)
            )
        )
        assert fired[-1].source == "inject"
        assert fired[-1].injected_by is not None
        return await evaluation_events(db, card_row)

    events = run_db(database_url, review)
    result = BrigadeWorkCriterion().evaluate(
        EvalContext({}, {}, [], [], {"weights": {"brigade_work": 1.0}}, scenario_events=events)
    )
    # Тревога без ответа — в разборе с пометкой вводной; оценка видит её как критичную.
    assert any("Вводная преподавателя" in line for line in result.evidence), result.evidence


def injects_status(client, session_id, headers):
    listed = client.get(f"/api/sessions/{session_id}/injects").status_code
    posted = client.post(
        f"/api/sessions/{session_id}/injects",
        json={"kind": "alarm", "targets": "all"},
        headers=headers,
    ).status_code
    return listed, posted
