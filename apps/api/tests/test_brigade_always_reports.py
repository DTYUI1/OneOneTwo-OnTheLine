"""GP-02: бригада всегда может доложить — карточка закрывается без вечного ожидания.

Эталон docs/dds_gameplay.md, 1.5: у сценария полный план докладов до завершающего статуса,
пауза между докладами — не больше 40 с; готовый доклад приходит звонком бригады.
"""

import copy
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from app.api.database import create_database_app
from app.api.sessions.practice import step_pool, tutorial_scenario_id
from app.api.training.plan_check import MAX_REPORT_PAUSE_S, missing_reports, report_pauses
from app.seed.training import check_catalog
from evalcore.progress import step_by_number  # type: ignore[import-untyped]
from fastapi.testclient import TestClient

from . import test_c03_sessions as c03
from .briefing_helpers import briefing_payload
from .test_brigade_callback import calls
from .test_c04_completion import seed_training
from .test_c04_training import playback
from .test_lifecycle import login, run_db
from .test_practice_gating import deliveries, practice, send, worker_tick

TRAINEE = "trainee05"
# Golden-сценарии кейсодержателя (data/golden_scenarios, case-01…10): учебного плана нет.
CASE_01 = UUID("00000000-0000-4000-8000-000000000100")
GOLDEN = {UUID(f"00000000-0000-4000-8000-0000000001{index:02d}") for index in range(10)}


def planned(stage: str, scenario_id: UUID, after: int, requires: str | None = None) -> dict:
    item = {
        "message": {"id": str(uuid4()), "version": 1},
        "available_after_s": after,
        "justifies_state": stage,
    }
    if requires:
        item["requires_state"] = requires
    return item


def test_plan_is_full_only_with_reports_up_to_final_status():
    flow = ["received", "accepted", "responding", "arrived", "working", "completed"]
    scenario = SimpleNamespace(id=uuid4(), reference={"expected_flow": flow})
    assert missing_reports(scenario, []) == ["arrived", "working", "completed"]
    partial = [planned("responding", scenario.id, 3), planned("arrived", scenario.id, 10)]
    assert missing_reports(scenario, partial) == ["working", "completed"]
    full = partial + [planned("working", scenario.id, 18), planned("completed", scenario.id, 26)]
    assert missing_reports(scenario, full) == []
    # Карточку закрывает решение диспетчера — бригада не нужна.
    rejected = SimpleNamespace(id=uuid4(), reference={"expected_flow": ["received", "rejected"]})
    assert missing_reports(rejected, []) == []


def test_pause_counts_from_status_or_from_previous_report():
    scenario_id = uuid4()
    gated = [
        planned("responding", scenario_id, 3, "accepted"),
        planned("arrived", scenario_id, 40, "responding"),
        planned("completed", scenario_id, 41, "arrived"),
    ]
    assert report_pauses(gated) == [3, 40, 41]
    by_clock = [planned(s, scenario_id, a) for s, a in [("arrived", 10), ("completed", 26)]]
    assert report_pauses(by_clock) == [10, 16]


def test_scenario_without_plan_is_not_offered_to_dds(database_config, database_url):
    seed_training(database_url)
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client)
        golden = client.get(f"/api/scenarios/{CASE_01}").json()
        assert golden["status"] == "approved"
        body = copy.deepcopy(golden)
        body["id"] = str(uuid4())
        assert client.post("/api/scenarios", json=body, headers=headers).status_code == 201
        response = client.get("/api/scenarios/playable")
        assert response.status_code == 200, response.text
        playable = set(response.json()["scenario_ids"])
        assert str(CASE_01) not in playable and body["id"] not in playable
        assert str(tutorial_scenario_id("102")) in playable
        assert client.get("/api/scenarios/playable", headers=headers).status_code == 200
        login(client, TRAINEE)
        assert client.get("/api/scenarios/playable").status_code == 403

    async def pools(db):
        return {
            item.id
            for number in (2, 3, 4)
            for item in await step_pool(db, step_by_number(number), "102")
        }

    pool = run_db(database_url, pools)
    assert pool, "у службы 102 есть сценарии для тренировки"
    assert CASE_01 not in pool and UUID(body["id"]) not in pool


def test_catalog_plans_reach_final_status_with_short_pauses(database_url):
    """Все сценарии каталога (seed) — либо с полным планом и паузами ≤ 40 с, либо golden,
    которые в тренировку и подбор не идут. Новый сценарий без плана заметит этот тест."""
    seed_training(database_url)
    check = run_db(database_url, check_catalog)

    def seeded(scenario) -> bool:
        # Сценарии других тестов — со случайным uuid4; у каталога id из data/ или uuid5.
        return scenario.id.version == 5 or str(scenario.id).startswith("00000000-")

    assert {item.id for item in check.unclosable if seeded(item)} == GOLDEN
    assert [item.card["number"] for item in check.slow if seeded(item)] == []
    assert MAX_REPORT_PAUSE_S == 40


def dispatched(client, headers, url):
    """Тренировка: карточка принята, бригада направлена и на линии."""
    session = practice(client, headers)
    assert c03.tick(url) >= 1
    card = next(c for c in client.get("/api/cards").json() if c["session_id"] == session["id"])
    service_id = session["participants"][0]["dds_service_id"]
    brigade_id = str(uuid5(NAMESPACE_URL, f"arm112:c04:{service_id}:brigade:0"))
    target_id = str(uuid5(NAMESPACE_URL, f"arm112:c04:{service_id}:target:0"))
    card_id = card["id"]
    send(client, headers, card_id, "deliver", {})
    send(client, headers, card_id, "open", {})
    send(client, headers, card_id, "status_change", {"state": "accepted", "comment": "Принята"})
    send(client, headers, card_id, "brigades_select", {"brigade_ids": [brigade_id]})
    call_id = str(uuid4())
    dial = {"call_id": call_id, "call_target_id": target_id, "brigade_id": brigade_id}
    send(client, headers, card_id, "call_dial_target", dial)
    send(client, headers, card_id, "call_answer", {"call_id": call_id})
    # Вводная (GP-05): бригада выезжает и сразу докладывает о выезде в этом разговоре.
    send(client, headers, card_id, "brigade_briefing", briefing_payload(card, call_id))
    return card_id, call_id


def inbound(url, card_id) -> list:
    return [call for call in calls(url, card_id) if call.direction == "inbound"]


def test_ready_report_rings_after_brigade_hung_up(database_config, database_url):
    seed_training(database_url)
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, TRAINEE)
        card_id, call_id = dispatched(client, headers, database_url)
        assert deliveries(database_url, UUID(card_id)) == 1
        first = client.get(f"/api/cards/{card_id}/training").json()["messages"][0]
        send(client, headers, card_id, "message_presented", playback(first["delivery"]))
        send(client, headers, card_id, "status_change", {"state": "responding", "comment": "Выезд"})
        # Сказать нечего — бригада кладёт трубку сама (Softphone: brigadeQuiet → call_hangup).
        send(client, headers, card_id, "call_hangup", {"call_id": call_id})
        hung_up = datetime.now(UTC)
        # Доклад о прибытии готов через 4 с после «Выезда»: звонок — не позже второго тика.
        for second in (5, 6):
            worker_tick(database_url, hung_up + timedelta(seconds=second))
            if inbound(database_url, UUID(card_id)):
                break
        (ringing,) = inbound(database_url, UUID(card_id))
        assert ringing.answered_at is None and ringing.ended_at is None


def test_report_unheard_before_hangup_rings_again(database_config, database_url):
    seed_training(database_url)
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, TRAINEE)
        card_id, call_id = dispatched(client, headers, database_url)
        now = datetime.now(UTC)
        # Доклад выдан в разговор, но бригада положила трубку раньше, чем его услышали.
        assert deliveries(database_url, UUID(card_id)) == 1
        send(client, headers, card_id, "call_hangup", {"call_id": call_id})
        worker_tick(database_url, now + timedelta(seconds=11))
        if not inbound(database_url, UUID(card_id)):
            worker_tick(database_url, now + timedelta(seconds=12))
        (ringing,) = inbound(database_url, UUID(card_id))

        # Ответили — тот же доклад звучит в этом разговоре, новый не выдаётся.
        send(client, headers, card_id, "call_answer", {"call_id": str(ringing.id)})
        worker_tick(database_url, now + timedelta(seconds=13))
        assert deliveries(database_url, UUID(card_id)) == 1
        (pending,) = client.get(f"/api/cards/{card_id}/training").json()["messages"]
        assert pending["state"] == "delivered"
        send(client, headers, card_id, "message_presented", playback(pending["delivery"]))
        send(client, headers, card_id, "call_hangup", {"call_id": str(ringing.id)})
        # Услышан — больше с ним не звонят (следующий доклад ждёт «Выезда»).
        worker_tick(database_url, now + timedelta(seconds=20))
        assert len(inbound(database_url, UUID(card_id))) == 1
