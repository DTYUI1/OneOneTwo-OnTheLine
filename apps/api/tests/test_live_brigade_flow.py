"""DT-10 с БД: расчёт повторяет адрес с ошибкой и спрашивает этаж, ответ (голосом — DT-16 —
или вариантом) меняет его следующую реплику, разбор видит реакцию и способ ответа. Сценарий
тренировки «Задымление в квартире», служба 101, полный цикл."""

import time
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from app.api.database import create_database_app
from app.api.training.scenario_events import evaluation_events
from app.api.voice_reply import service as voice_reply_service
from app.core.contracts import validate_json
from app.core.models import Card, ScenarioEventFiring
from app.seed.scenarios import file_scenario_id
from app.worker.providers.interfaces import Recognition
from evalcore.brigade import BrigadeWorkCriterion
from evalcore.models import EvalContext
from fastapi.testclient import TestClient
from sqlalchemy import select

from . import test_c03_sessions as c03
from .briefing_helpers import briefing_payload
from .test_c04_completion import seed_training
from .test_lifecycle import login, run_db
from .test_practice_gating import send, worker_tick
from .test_voice_report import AUDIO, FakeSTT

TRAINEE = "trainee02"  # ДДС 101
SCENARIO = file_scenario_id("smoke-apartment-101-1")


def present(client, headers, card_id, item):
    delivery = item["delivery"]
    audio = delivery["message"]["audio"]
    send(
        client,
        headers,
        card_id,
        "message_presented",
        {
            "delivery_id": delivery["delivery_id"],
            "message_version": delivery["message"]["version"],
            "playback_id": str(uuid4()),
            "channel": "audio" if audio else "text",
            "audio_version": audio["version"] if audio else None,
        },
    )


def voice_reply(client, headers, call_id, delivery_id):
    return client.post(
        f"/api/calls/{call_id}/voice-reply",
        data={} if delivery_id is None else {"delivery_id": delivery_id},
        files={"audio": AUDIO},
        headers=headers,
    )


def training(client, card_id):
    body = client.get(f"/api/cards/{card_id}/training").json()
    validate_json(body, "urn:openapi#/components/schemas/CardTraining")
    return body


def step(client, headers, card_id, database_url, state: str, comment: str) -> None:
    """Следующий доклад бригады прозвучал — диспетчер ставит статус."""
    worker_tick(database_url, datetime.now(UTC) + timedelta(seconds=10))
    item = next(m for m in training(client, card_id)["messages"] if m["state"] != "presented")
    present(client, headers, card_id, item)
    send(client, headers, card_id, "status_change", {"state": state, "comment": comment})


def readback_heard(database_config, database_url, request) -> tuple[dict, str, dict]:
    """Занятие до повтора адреса с ошибкой: вводная, доклад о выезде, повтор услышан.

    Возвращает карточку, звонок бригаде и реплику-повтор."""
    seed_training(database_url)
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client)
        users = {u["login"]: u for u in client.get("/api/users").json()}
        scenario = client.get(f"/api/scenarios/{SCENARIO}").json()
        settings = client.get("/api/settings").json()
        assert settings["weights"]["brigade_work"] == 1
        created = client.post(
            "/api/sessions",
            headers=headers,
            json={
                "title": "Живая бригада",
                "participants": [
                    {
                        "user_id": users[TRAINEE]["id"],
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
            # Идущее занятие у trainee02 мешает соседним тестам практики: завершаем всегда.
            with TestClient(create_database_app(database_config)) as teacher:
                teacher.post(
                    f"/api/sessions/{session_id}/finish",
                    json={"contract_version": 2, "request_id": str(uuid4())},
                    headers=login(teacher),
                )

        request.addfinalizer(finish)
        body = {
            "request_id": str(uuid4()),
            "items": [
                {
                    "participant_id": users[TRAINEE]["id"],
                    "scenario_id": str(SCENARIO),
                    "scenario_version": scenario["version"],
                    "order": 1,
                    "delay_from_start_s": 0,
                    "delivery_mode": "profile",
                }
            ],
        }
        response = client.post(
            f"/api/sessions/{session_id}/assignments/batch", json=body, headers=headers
        )
        assert response.status_code == 201, response.text
        assert client.post(f"/api/sessions/{session_id}/start", headers=headers).status_code == 200
        assert c03.tick(database_url) >= 1

    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, TRAINEE)
        card = next(c for c in client.get("/api/cards").json() if c["session_id"] == session_id)
        card_id = card["id"]
        roster = training(client, card_id)
        brigade_id = roster["available_brigade_ids"][0]
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

        step(client, headers, card_id, database_url, "responding", "Расчёт выехал")

        # Через 1 с после доклада о выезде расчёт повторяет адрес с ошибкой — поправляем.
        worker_tick(database_url, datetime.now(UTC) + timedelta(seconds=5))
        readback = next(
            m for m in training(client, card_id)["messages"] if "reply_options" in m["delivery"]
        )
        assert "Бескудниковский переулок" in readback["delivery"]["message"]["text"]
        assert readback["delivery"]["call_id"] == call_id
        present(client, headers, card_id, readback)
        # Событие сработало через 1 с после доклада о выезде; раньше поправить нельзя.
        time.sleep(1.1)
    return card, call_id, readback


def test_brigade_asks_floor_and_answer_changes_world(
    database_config, database_url, request, monkeypatch
):
    # Сопоставлению ответа голосом передаётся текст реплики бригады — повтор адреса, от
    # которого поправка должна отличаться (HQ-024).
    questions: list[str] = []
    matcher = voice_reply_service.voice_reply_option

    def spy(options, text, checker, card=None, question=""):
        questions.append(question)
        return matcher(options, text, checker, card, question)

    monkeypatch.setattr(voice_reply_service, "voice_reply_option", spy)
    card, call_id, readback = readback_heard(database_config, database_url, request)
    card_id = card["id"]
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, TRAINEE)
        # DT-16: поправка голосом. Ловушка — переулок вместо бульвара — не сопоставляется.
        delivery_id = readback["delivery"]["delivery_id"]
        fake = FakeSTT("Бескудниковский переулок, двадцать четыре", 0.8)
        client.app.state.voice_report_stt = fake
        assert voice_reply(client, headers, call_id, delivery_id).json()["option_key"] is None
        assert "Бескудниковский бульвар" in fake.hints
        assert questions == [readback["delivery"]["message"]["text"]]
        fake.result = Recognition("Нет, Бескудниковский бульвар, двадцать четыре", 0.8)
        heard = voice_reply(client, headers, call_id, delivery_id)
        assert heard.status_code == 200, heard.text
        assert heard.json()["option_key"] == "fix"
        assert voice_reply(client, headers, call_id, str(uuid4())).status_code == 404
        send(
            client,
            headers,
            card_id,
            "brigade_reply",
            {
                "call_id": call_id,
                "delivery_id": delivery_id,
                "option_key": "fix",
                "mode": "voice",
                "text": heard.json()["text"],
                "loudness": heard.json()["loudness"],
                "voice_failures": 1,
            },
        )
        # На реплику уже ответили — голосом больше не отвечают.
        assert voice_reply(client, headers, call_id, delivery_id).status_code == 409
        # Не последней: доклад о выезде датирован будущим тиком worker.
        answer = next(
            m
            for m in training(client, card_id)["messages"]
            if m["delivery"]["message"]["text"] == "Принял поправку, перестраиваем маршрут."
        )
        present(client, headers, card_id, answer)

        step(client, headers, card_id, database_url, "arrived", "Расчёт на месте")

        # Через 2 с после доклада о прибытии расчёт спрашивает этаж — в том же разговоре.
        worker_tick(database_url, datetime.now(UTC) + timedelta(seconds=5))
        question = next(
            m
            for m in training(client, card_id)["messages"]
            if "reply_options" in m["delivery"] and m["reply_key"] is None
        )
        assert question["delivery"]["call_id"] == call_id
        assert question["reply_key"] is None
        assert {o["key"] for o in question["delivery"]["reply_options"]} >= {"floor_9", "unknown"}
        assert "option_key" not in str(question) and "branches" not in str(question)
        assert "reply_by" not in question["delivery"]  # ещё не услышан — срока нет
        present(client, headers, card_id, question)
        # Услышан — срок ответа (30 с) от того, как услышали, но не раньше срабатывания (тик
        # worker выше датирован будущим): HQ-058, окно телефона по нему решает, повторять ли
        # вопрос после удержания.
        heard = next(
            m
            for m in training(client, card_id)["messages"]
            if m["delivery"]["delivery_id"] == question["delivery"]["delivery_id"]
        )
        left = datetime.fromisoformat(heard["delivery"]["reply_by"]) - datetime.fromisoformat(
            heard["presented_at"]
        )
        assert timedelta(seconds=30) <= left <= timedelta(seconds=36)
        time.sleep(2.1)  # вопрос об этаже звучит через 2 с после доклада о прибытии

        reply = {
            "call_id": call_id,
            "delivery_id": question["delivery"]["delivery_id"],
            "option_key": "floor_9",
        }
        send(client, headers, card_id, "brigade_reply", {**reply, "option_key": "nope"}, 422)
        send(client, headers, card_id, "brigade_reply", reply)
        send(client, headers, card_id, "brigade_reply", reply, 409)

        # Ответ «девятый» — расчёт отвечает в том же разговоре, без тика worker.
        messages = training(client, card_id)["messages"]
        assert (
            next(m for m in messages if m["delivery"]["delivery_id"] == reply["delivery_id"])[
                "reply_key"
            ]
            == "floor_9"
        )
        # Не последней: тики worker выше датированы будущим, а реплики идут по delivered_at.
        texts = [m["delivery"]["message"]["text"] for m in messages]
        assert "Понял, поднимаемся." in texts

    async def review(db):
        card_row = await db.get(Card, UUID(card_id))
        fired = list(
            await db.scalars(
                select(ScenarioEventFiring).where(ScenarioEventFiring.card_id == card_row.id)
            )
        )
        assert [item.source for item in fired] == ["plan", "plan"]
        return await evaluation_events(db, card_row)

    events = run_db(database_url, review)
    result = BrigadeWorkCriterion().evaluate(
        EvalContext({}, {}, [], [], {"weights": {"brigade_work": 1.0}}, scenario_events=events)
    )
    assert result.score == 1.0
    assert not result.critical
    assert result.evidence[0].startswith("Расчёт повторил адрес с ошибкой: поправили голосом через")
    assert result.evidence[0].endswith("голос не сопоставлен: 1).")
    assert result.evidence[1].startswith(
        "Расчёт спросил этаж — он был в описании карточки: ответили вариантом «Девятый этаж» через"
    )


def test_readback_fixed_by_phrase_after_understood(database_config, database_url, request):
    """«Понял» на повтор с ошибкой, следом верный адрес фразой бригаде — поправка (HQ-024).

    Повторная вводная поправкой не считается. На поправку фразой — и с «доложите» — бригада
    отвечает одной репликой ветки («Принял поправку…»): распознавание фразы говорит окну
    телефона `world_answers`, своего «Принял» или «Еду, доложу» оно не даёт."""
    card, call_id, readback = readback_heard(database_config, database_url, request)
    card_id = card["id"]
    delivery_id = readback["delivery"]["delivery_id"]

    async def readback_outcome(db):
        events = await evaluation_events(db, await db.get(Card, UUID(card_id)))
        result = BrigadeWorkCriterion().evaluate(
            EvalContext({}, {}, [], [], {"weights": {"brigade_work": 1.0}}, scenario_events=events)
        )
        return result.evidence[0]

    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, TRAINEE)
        reply = {"call_id": call_id, "delivery_id": delivery_id, "option_key": "ok"}
        send(client, headers, card_id, "brigade_reply", reply)
        send(client, headers, card_id, "brigade_briefing", briefing_payload(card, call_id))
        assert "не поправили" in run_db(database_url, readback_outcome)
        fake = FakeSTT("Выезжайте", 0.8)
        client.app.state.voice_report_stt = fake
        assert voice_reply(client, headers, call_id, None).json()["world_answers"] is False
        fake.result = Recognition("Бескудниковский бульвар 24, доложите по прибытии", 0.8)
        assert voice_reply(client, headers, call_id, None).json()["world_answers"] is True
        send(
            client,
            headers,
            card_id,
            "brigade_said",
            {"call_id": call_id, "text": "Нет, Бескудниковский бульвар, двадцать четыре"},
        )
        texts = [m["delivery"]["message"]["text"] for m in training(client, card_id)["messages"]]
        assert texts.count("Принял поправку, перестраиваем маршрут.") == 1
        # Поправка уже засчитана: следующая фраза с адресом — снова ответ окна телефона.
        assert voice_reply(client, headers, call_id, None).json()["world_answers"] is False
    assert run_db(database_url, readback_outcome).startswith(
        "Расчёт повторил адрес с ошибкой: поправили голосом через"
    )
