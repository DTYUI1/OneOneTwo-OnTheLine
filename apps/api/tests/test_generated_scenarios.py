"""GP-14: ИИ готовит, выдаёт и оценивает сценарии по уровню обучаемого."""

import asyncio
import json
from datetime import UTC, datetime, timedelta
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

import pytest
from app.api.database import create_database_app
from app.api.progress.advice import advice, weak_spots
from app.api.training.autogen import GENERATED_PACK_ID
from app.core.config import ROOT
from app.core.models import Card, Scenario, ScenarioPackItem
from app.seed import generator
from app.seed.generator import check, generate, generate_checked
from app.seed.scenario_lint import changes_world, deadline_s
from app.seed.scenarios import load_catalog
from app.worker.providers.llm.mock import MockLLM
from evalcore.progress import StepAttempt
from fastapi.testclient import TestClient
from sqlalchemy import select

from .briefing_helpers import briefing_payload
from .test_c04_completion import seed_training
from .test_c04_training import playback
from .test_lifecycle import login, run_db
from .test_practice_gating import send, worker_tick

SERVICES = {item["id"] for item in json.loads((ROOT / "data/phonebook.json").read_text())}
DDS = sorted(
    item["id"]
    for item in json.loads((ROOT / "data/phonebook.json").read_text())
    if item["category"] != "system112"
)
CATALOG = load_catalog(SERVICES).scenarios
T0 = datetime(2026, 10, 16, 10, tzinfo=UTC)


class Narrator:
    """Модель-заглушка с заданным ответом."""

    name = "local"

    def __init__(self, answer):
        self.answer = answer

    async def complete_json(self, prompt):
        self.prompt = prompt
        return self.answer


@pytest.mark.parametrize("service_id", DDS)
@pytest.mark.parametrize("level", [1, 2, 3, 4])
def test_template_path_gives_valid_v2_file_for_every_service_and_level(service_id, level):
    data = generate(CATALOG, service_id=service_id, level=level, seed=level * 1000 + 7)
    assert check(data, SERVICES) == []
    assert (data["format"], data["service_id"], data["level"]) == (2, service_id, level)
    assert set(data["input_parts"]) == {"who", "address", "what", "people", "decision"}
    assert data["reference"]["expected_address"] == data["card"]["address"]
    assert "outcome" not in data  # Старый адрес и исход удалённых событий не переносятся.
    call = data["reference"]["expected_call"]
    assert not (call["required"] and call.get("contact_role"))
    events = {item["key"] for item in data.get("events", [])}
    # Ловушки по уровню: с 3-го — повтор адреса с ошибкой, с 4-го — ещё и молчание бригады.
    assert ("readback" in events) == (level >= 3)
    assert ("silence" in events) == (level >= 4)
    chained = {
        e["trigger"]["event"] for e in data.get("events", []) if e["trigger"]["on"] == "event"
    }
    for event in data.get("events", []):
        deadline = deadline_s(event)
        if deadline is not None and changes_world(event, chained):
            assert deadline <= 40


def test_generated_scenarios_differ_and_weak_spot_adds_trap():
    first = generate(CATALOG, service_id="101", level=1, seed=1)
    second = generate(CATALOG, service_id="101", level=1, seed=2)
    assert first["code"] != second["code"]
    assert first["card"]["number"] != second["card"]["number"]
    focused = generate(CATALOG, service_id="101", level=1, seed=1, focus="address")
    assert focused.get("traps") == ["readback"] and check(focused, SERVICES) == []


def test_unknown_service_has_no_templates():
    with pytest.raises(ValueError):
        generate(CATALOG, service_id="999", level=1, seed=1)


def test_mock_provider_passes_schema_and_keeps_template_text():
    result = asyncio.run(
        generate_checked(CATALOG, SERVICES, service_id="102", level=2, seed=5, llm=MockLLM())
    )
    assert result is not None
    data, origin = result
    # Ответ mock — не повествование по схеме: оно отброшено, остаётся шаблон.
    assert origin == "template" and check(data, SERVICES) == []


def test_valid_narrative_is_applied_and_invalid_is_discarded():
    template = generate(CATALOG, service_id="103", level=1, seed=9)
    street = template["card"]["address"]["street"]
    good = {
        "caller_name": "Иванова Мария Петровна",
        "description": f"На {street} мужчине стало плохо прямо на улице, он сидит на скамейке "
        "и жалуется на боль в груди, просит вызвать врача.",
        "tags": ["улица"],
    }
    result = asyncio.run(
        generate_checked(CATALOG, SERVICES, service_id="103", level=1, seed=9, llm=Narrator(good))
    )
    assert result is not None
    data, origin = result
    assert origin == "llm" and data["card"]["description"] == good["description"]
    assert data["reference"]["expected_comment"].startswith(good["description"])

    for broken in (
        {**good, "description": "Коротко."},  # не по схеме
        {**good, "description": "Человеку плохо на другой улице, " * 4},  # нет улицы карточки
        {"provider": "x"},
        None,
    ):
        result = asyncio.run(
            generate_checked(
                CATALOG, SERVICES, service_id="103", level=1, seed=9, llm=Narrator(broken)
            )
        )
        assert result is not None and result[1] == "template"
        assert result[0]["card"]["description"] == template["card"]["description"]


def test_invalid_scenario_is_discarded(monkeypatch):
    real = generator.generate

    def without_completion(*args, **kwargs):
        data = real(*args, **kwargs)
        data["plan"] = data["plan"][:1]
        return data

    monkeypatch.setattr(generator, "generate", without_completion)
    result = asyncio.run(generate_checked(CATALOG, SERVICES, service_id="101", level=1, seed=3))
    assert result is None


def test_advice_names_weakest_criteria_and_next_step():
    scores = [
        {"address": 0.0, "status_flow": 0.5, "reaction_time": 1.0},
        {"address": 0.0, "status_flow": 1.0, "reaction_time": 1.0},
    ]
    assert weak_spots(scores) == ["address", "status_flow"]
    result = advice(scores, 3, "Сложные карточки")
    assert result is not None
    assert [item["criterion"] for item in result["focus"]] == ["address", "status_flow"]
    assert result["next_step"] == 3 and "ступень 3" in result["next"]
    assert advice([], 1, "Интерфейс") is None
    clean = advice([{"address": 1.0}], 2, "Своя карточка")
    assert clean is not None and clean["focus"] == []


# --- с базой ---


def levels_by_user(levels: dict[str, list[int]]):
    """Подмена истории попыток: путь каждого обучаемого задан списком уровней пройденных."""

    async def history(db, user_id):
        from app.core.models import User

        login_name = await db.scalar(select(User.login).where(User.id == user_id))
        passed = levels.get(login_name, [])
        return [StepAttempt(1, True, True, T0)] + [
            StepAttempt(level, False, True, T0 + timedelta(minutes=index + 1))
            for index, level in enumerate(passed)
        ]

    return history


def issued(url, session_id: str) -> list[Scenario]:
    async def read(db):
        from app.core.models import Assignment

        return list(
            await db.scalars(
                select(Scenario)
                .join(Assignment, Assignment.scenario_id == Scenario.id)
                .where(Assignment.session_id == UUID(session_id))
                .order_by(Assignment.order)
            )
        )

    return run_db(url, read)


def generated_ids(url) -> set[UUID]:
    async def read(db):
        return set(
            await db.scalars(
                select(ScenarioPackItem.scenario_id).where(
                    ScenarioPackItem.pack_id == GENERATED_PACK_ID
                )
            )
        )

    return run_db(url, read)


def practice(client, headers, step: int) -> dict:
    response = client.post(f"/api/practice?step={step}", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def until_generated(client, headers, url, step: int, limit: int = 40) -> tuple[dict, Scenario]:
    """Тренироваться на ступени, пока готовые не кончатся и не придёт сгенерированный."""
    for _ in range(limit):
        session = practice(client, headers, step)
        [scenario, *_] = issued(url, session["id"])
        if scenario.id in generated_ids(url):
            return session, scenario
    raise AssertionError("Сгенерированный сценарий так и не выдан.")


def test_practice_of_level_gets_generated_scenario_of_that_level(
    database_config, database_url, monkeypatch
):
    seed_training(database_url)
    monkeypatch.setattr(
        "app.api.progress.service.trainee_attempts",
        levels_by_user({"trainee02": [1, 1, 1, 2, 2, 2]}),
    )
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, "trainee02")
        _, second = until_generated(client, headers, database_url, 2)
        assert (second.level, second.status, second.target_service_id) == (1, "draft", "101")
        _, fourth = until_generated(client, headers, database_url, 4)
        # HQ-032: параллельная ступень теперь выдаёт сценарии уровней 1–2.
        assert fourth.level in (1, 2) and fourth.status == "draft"


def test_two_trainees_of_different_levels_get_different_scenarios(
    database_config, database_url, monkeypatch
):
    seed_training(database_url)
    monkeypatch.setattr(
        "app.api.progress.service.trainee_attempts",
        levels_by_user({"trainee04": [], "trainee05": [1, 1, 1]}),
    )
    picked = {}
    for name in ("trainee04", "trainee05"):
        with TestClient(create_database_app(database_config)) as client:
            headers = login(client, name)
            [own] = client.get("/api/progress").json()
            # Без преподавателя: обучаемый берёт текущую ступень своего пути.
            session = practice(client, headers, own["current_step"])
            [scenario] = issued(database_url, session["id"])
            picked[name] = (own["current_step"], scenario.level, scenario.id)
    assert picked["trainee04"][:2] == (2, 1)
    assert picked["trainee05"][:2] == (3, 2)
    assert picked["trainee04"][2] != picked["trainee05"][2]


def test_generated_scenario_is_played_to_closed_card_and_advised(
    database_config, database_url, monkeypatch
):
    seed_training(database_url)
    monkeypatch.setattr(
        "app.api.progress.service.trainee_attempts", levels_by_user({"trainee05": [1, 1, 1]})
    )
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, "trainee05")
        session, scenario = until_generated(client, headers, database_url, 3)
        from . import test_c03_sessions as c03

        assert c03.tick(database_url) >= 1
        card = next(c for c in client.get("/api/cards").json() if c["session_id"] == session["id"])
        card_id = card["id"]
        service_id = session["participants"][0]["dds_service_id"]
        brigade_id = str(uuid5(NAMESPACE_URL, f"arm112:c04:{service_id}:brigade:0"))
        target_id = str(uuid5(NAMESPACE_URL, f"arm112:c04:{service_id}:target:0"))
        send(client, headers, card_id, "deliver", {})
        send(client, headers, card_id, "status_change", {"state": "accepted", "comment": "Принята"})
        send(client, headers, card_id, "brigades_select", {"brigade_ids": [brigade_id]})
        call_id = str(uuid4())
        send(
            client,
            headers,
            card_id,
            "call_dial_target",
            {"call_id": call_id, "call_target_id": target_id, "brigade_id": brigade_id},
        )
        send(client, headers, card_id, "call_answer", {"call_id": call_id})
        send(client, headers, card_id, "brigade_briefing", briefing_payload(card, call_id))

        presented: set[str] = set()
        now = datetime.now(UTC)
        flow = [s for s in scenario.reference["expected_flow"] if s not in {"received", "added"}]
        for state in flow[1:]:
            now += timedelta(seconds=60)
            worker_tick(database_url, now)
            training = client.get(f"/api/cards/{card_id}/training").json()
            for item in training["messages"]:
                delivery = item["delivery"]
                if delivery["delivery_id"] in presented:
                    continue
                presented.add(delivery["delivery_id"])
                send(client, headers, card_id, "message_presented", playback(delivery))
            send(
                client,
                headers,
                card_id,
                "status_change",
                {"state": state, "comment": "По докладу бригады: " + state},
            )

        async def closed(db):
            return (await db.get(Card, UUID(card_id))).closed_at

        assert run_db(database_url, closed) is not None
        assert len(presented) == len(flow) - 1
        [own] = client.get("/api/progress").json()
        assert own["advice"] is not None
        assert own["advice"]["next_step"] == own["current_step"]
