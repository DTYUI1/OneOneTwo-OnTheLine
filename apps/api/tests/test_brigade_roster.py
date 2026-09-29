"""Занятость бригад (28.09): бригада на незакрытом происшествии на другое не едет."""

from uuid import UUID, uuid4

from app.api.database import create_database_app
from app.api.training.brigades import assign_crew, brigade_limit
from app.api.training.content import store_plan
from app.core.contracts import validate_json
from app.core.models import Call, User
from fastapi.testclient import TestClient
from sqlalchemy import select

from . import test_c03_sessions as c03
from .test_lifecycle import event, login, run_db

lesson = c03.lesson


def test_more_incidents_bring_more_brigades():
    assert [brigade_limit(n) for n in range(1, 9)] == [2, 2, 2, 3, 3, 4, 4, 5]


def test_plan_brigade_is_a_role_taken_by_dispatched_brigade():
    first, second, third = uuid4(), uuid4(), uuid4()
    plan = [{"brigade_id": str(first)}, {"brigade_id": str(first)}]
    # Направлена сама бригада плана — докладывает она.
    assert assign_crew(plan, [first, second]) == {first: first}
    # Её заняли на другом происшествии — роль берёт направленная.
    assert assign_crew(plan, [second]) == {first: second}
    assert assign_crew(plan, []) == {}
    # Две роли плана: своя бригада остаётся за собой, свободная роль — первой из прочих.
    two = [{"brigade_id": str(first)}, {"brigade_id": str(second)}]
    assert assign_crew(two, [third, second]) == {second: second, first: third}


def test_working_brigade_keeps_its_role_when_reinforcement_arrives():
    first, second = uuid4(), uuid4()
    plan = [{"brigade_id": str(first)}, {"brigade_id": str(first)}]
    # Бригада плана была занята, работала вторая; бригаду плана направили позже
    # подкреплением — доклады остаются за второй, с которой уже был разговор.
    assert assign_crew(plan, [first, second], [second]) == {first: second}
    assert assign_crew(plan, [first, second], [first, second]) == {first: first}
    # С отменённой (не направленной больше) бригадой разговор роль не держит.
    assert assign_crew(plan, [first], [second]) == {first: first}


def send(client, headers, card_id, kind, payload, expected=200):
    body = event(kind, payload)
    body["client_ts"] = body["client_ts"].replace("+00:00", "Z")
    response = client.post(f"/api/cards/{card_id}/events", json=body, headers=headers)
    assert response.status_code == expected, response.text
    return response


def training(client, card_id):
    response = client.get(f"/api/cards/{card_id}/training")
    assert response.status_code == 200, response.text
    result = response.json()
    validate_json(result, "urn:openapi#/components/schemas/CardTraining")
    return result


def test_busy_brigade_and_report_from_dispatched_brigade(lesson, database_config, database_url):
    service_id = lesson.scenarios[0]["target_service_id"]
    brigades = lesson.client.get(f"/api/services/{service_id}/brigades").json()
    targets = lesson.client.get(f"/api/services/{service_id}/call-targets").json()
    first, second = brigades[0], brigades[1]
    target_of = {t["brigade_id"]: t for t in targets if t["brigade_id"]}
    plan = {
        "version": 1,
        "required_brigade_ids": [first["id"]],
        "messages": [
            {
                "message": {
                    "id": str(uuid4()),
                    "version": 1,
                    "text": "Бригада выехала.",
                    "audio": None,
                },
                "brigade_id": first["id"],
                "call_target_id": target_of[first["id"]]["id"],
                "available_after_s": 0,
                "expected_comment": "Бригада выехала.",
            }
        ],
        "observable_defects": [],
    }

    async def prepare(db):
        teacher = await db.scalar(select(User).where(User.login == "teacher"))
        await store_plan(
            db, UUID(lesson.scenarios[0]["id"]), lesson.scenarios[0]["version"], teacher.id, plan
        )

    run_db(database_url, prepare)
    # Два происшествия у одного обучаемого, параллельно (parallel_cards 2, уровень 2).
    c03.batch(
        lesson,
        [c03.item(lesson, order=1), c03.item(lesson, order=2), c03.item(lesson, participant=1)],
    )
    c03.start(lesson)
    assert c03.tick(database_url) == 3
    with TestClient(create_database_app(database_config)) as trainee:
        headers = login(trainee, "trainee01")
        cards = sorted(
            (c for c in trainee.get("/api/cards").json() if c["session_id"] == lesson.id),
            key=lambda c: c["appeared_at"],
        )
        assert len(cards) == 2
        a, b = (card["id"] for card in cards)
        for card_id in (a, b):
            send(trainee, headers, card_id, "deliver", {})
            send(trainee, headers, card_id, "status_change", {"state": "accepted", "comment": "Да"})

        send(trainee, headers, a, "brigades_select", {"brigade_ids": [first["id"]]})
        view = training(trainee, b)
        # Два происшествия — две бригады; первая занята на другой карточке.
        assert view["available_brigade_ids"] == [first["id"], second["id"]]
        assert view["busy_brigades"] == [
            {"brigade_id": first["id"], "card_id": a, "card_number": cards[0]["source"]["number"]}
        ]
        assert training(trainee, a)["busy_brigades"] == []

        refused = send(trainee, headers, b, "brigades_select", {"brigade_ids": [first["id"]]}, 422)
        assert "занята" in refused.json()["message"]
        # Третья бригада службы при двух происшествиях недоступна.
        send(trainee, headers, b, "brigades_select", {"brigade_ids": [brigades[2]["id"]]}, 422)
        send(trainee, headers, b, "brigades_select", {"brigade_ids": [second["id"]]})

        # Позвонить занятой бригаде можно: она ответит, что на другом происшествии.
        busy_call = str(uuid4())
        send(
            trainee,
            headers,
            b,
            "call_dial_target",
            {
                "call_id": busy_call,
                "call_target_id": target_of[first["id"]]["id"],
                "brigade_id": first["id"],
            },
        )
        send(trainee, headers, b, "call_answer", {"call_id": busy_call})
        send(trainee, headers, b, "call_hangup", {"call_id": busy_call})

        async def refusal(db):
            return (await db.get(Call, UUID(busy_call))).refusal

        assert run_db(database_url, refusal) == "busy"
        assert training(trainee, b)["messages"] == []

        # Доклад плана бригады 1 приходит от направленной бригады 2 по её номеру.
        call_id = str(uuid4())
        send(
            trainee,
            headers,
            b,
            "call_dial_target",
            {
                "call_id": call_id,
                "call_target_id": target_of[second["id"]]["id"],
                "brigade_id": second["id"],
            },
        )
        send(trainee, headers, b, "call_answer", {"call_id": call_id})
        messages = training(trainee, b)["messages"]
        assert len(messages) == 1
        assert messages[0]["delivery"]["brigade_id"] == second["id"]
        assert messages[0]["delivery"]["call_target_id"] == target_of[second["id"]]["id"]

        # Бригаду другой службы напрямую не вызвать: у ДДС нет с ней связи.
        foreign_service = "103" if service_id != "103" else "102"
        foreign = next(
            t
            for t in lesson.client.get(f"/api/services/{foreign_service}/call-targets").json()
            if t["brigade_id"]
        )
        send(
            trainee,
            headers,
            b,
            "call_dial_target",
            {
                "call_id": str(uuid4()),
                "call_target_id": foreign["id"],
                "brigade_id": foreign["brigade_id"],
            },
            422,
        )
