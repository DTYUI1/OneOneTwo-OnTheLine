"""Сценарии самостоятельной тренировки (29.09): у каждой службы есть что проходить без
преподавателя, и сценарий без докладов бригады в тренировку не попадает."""

import hashlib
import json
from collections import Counter
from uuid import UUID

from app.api.database import create_database_app
from app.api.sessions.practice import step_pool
from app.core.config import ROOT
from app.core.contracts import validate_json
from app.core.models import Assignment, Scenario, ScenarioTrainingPlan
from app.seed.practice import (
    audio_path,
    expected_flow,
    load_incidents,
    scenario_id,
    scenario_payload,
    stages,
    variants,
)
from app.seed.training import STAGE_JUSTIFIES
from evalcore.progress import STEPS, StepAttempt
from fastapi.testclient import TestClient
from sqlalchemy import select

from .test_c04_completion import seed_training
from .test_lifecycle import login, run_db
from .test_progress import T0, issued, practice

INCIDENTS = load_incidents()
PHONEBOOK = {item["id"]: item for item in json.loads((ROOT / "data/phonebook.json").read_text())}
TRAINEE_SERVICES = sorted(
    {
        user["dds_service_id"]
        for user in json.loads((ROOT / "data/seed/demo_users.json").read_text())
        if user["role"] == "trainee"
    }
)
# Ступени, которые проходятся на одиночных карточках: 2 — уровень 1, 3 — уровень 2.
SINGLE_STEPS = [step for step in STEPS if not step.tutorial and step.parallel == 1]
MIN_PER_STEP = 3


def test_seven_incidents_each_with_distinct_card():
    assert len(INCIDENTS) == 7
    assert len({item["key"] for item in INCIDENTS}) == 7
    assert len({item["incident_type_code"] for item in INCIDENTS}) == 7
    numbers = [
        scenario_payload(item, service, level, PHONEBOOK[service]["phone_ext"])["card"]["number"]
        for item in INCIDENTS
        for service, level in variants(item)
    ]
    assert len(numbers) == len(set(numbers))
    assert all(len(number) == 8 and number.isdigit() for number in numbers)


def test_payloads_follow_contract_and_classifier():
    classifier = json.loads((ROOT / "data/classifier.json").read_text())
    routed: dict[str, set[str]] = {}
    for rule in classifier["routing_rules"]:
        routed.setdefault(rule["incident_type_code"], set()).add(rule["service_id"])
    for item in INCIDENTS:
        code = item["incident_type_code"]
        # Службы карточки — те, в которые классификатор направляет этот тип.
        assert set(item["card"]["service_ids"]) <= routed[code], item["key"]
        assert set(item["services"]) <= set(item["card"]["service_ids"]), item["key"]
        for service, level in variants(item):
            payload = scenario_payload(item, service, level, PHONEBOOK[service]["phone_ext"])
            validate_json(payload, "https://arm112.local/contracts/scenario.schema.json")
            assert payload["level"] == level
            assert (
                payload["reference"]["expected_call"]["phone_ext"]
                == (PHONEBOOK[service]["phone_ext"])
            )


def test_every_report_waits_for_the_previous_status_and_justifies_the_next():
    for item in INCIDENTS:
        for service, level in variants(item):
            variant = item["services"][service]
            plan = stages(variant, level)
            flow = expected_flow(variant, level)
            after_decision = flow[flow.index("accepted") + 1 :]
            # Каждый статус хода работ эталона обоснован докладом (памятка ДДС, стр. 22).
            assert [stage.justifies for stage in plan] == after_decision, (item["key"], service)
            # Доклад ждёт предыдущего статуса диспетчера — как в обучающем упражнении.
            assert [stage.requires for stage in plan] == ["accepted", *after_decision[:-1]]
            assert all(stage.text.strip() for stage in plan)
            if level == 1:
                assert flow[-1] == "completed"
                assert [stage.justifies for stage in plan] == [
                    STAGE_JUSTIFIES[name]
                    for name in ("departure", "arrival", "works", "completion")
                ]
            else:
                # Служба 103 «Отказ от выполнения работ» не ставит (памятка ДДС, стр. 23).
                assert flow[-1] == ("completed" if service == "103" else "refused")
                assert "working" not in flow


def test_each_trainee_service_has_several_scenarios_on_steps_two_and_three():
    per_level = Counter((service, level) for item in INCIDENTS for service, level in variants(item))
    for service in TRAINEE_SERVICES:
        for step in SINGLE_STEPS:
            count = sum(per_level[(service, level)] for level in step.levels)
            assert count >= MIN_PER_STEP, (service, step.number, count)


def test_every_report_is_voiced_with_matching_text():
    voices = ROOT / "data" / "voices"
    manifest = {
        item["path"]: item
        for item in json.loads((voices / "practice/manifest.json").read_text())["messages"]
    }
    for item in INCIDENTS:
        for service, level in variants(item):
            for stage in stages(item["services"][service], level):
                path = audio_path(item["key"], service, level, stage.name)
                assert path in manifest, path
                assert manifest[path]["text"] == stage.text, path
                digest = hashlib.sha256((voices / path).read_bytes()).hexdigest()
                assert digest == manifest[path]["sha256"], path


def practice_ids() -> set[UUID]:
    return {
        scenario_id(item["key"], service, level)
        for item in INCIDENTS
        for service, level in variants(item)
    }


def test_practice_pool_has_only_scenarios_with_brigade_reports(database_url):
    seed_training(database_url)
    ours = practice_ids()

    async def check(db):
        for service in TRAINEE_SERVICES:
            for step in SINGLE_STEPS:
                silent = await db.scalar(
                    select(Scenario.id).where(
                        Scenario.status == "approved",
                        Scenario.level.in_(step.levels),
                        Scenario.target_service_id == service,
                        Scenario.origin == "template",
                        ~select(ScenarioTrainingPlan.scenario_id)
                        .where(ScenarioTrainingPlan.scenario_id == Scenario.id)
                        .exists(),
                    )
                )
                pool = {item.id for item in await step_pool(db, step, service)}
                # Сценарий без плана (бригада молчит) в тренировку не идёт.
                assert silent is None or silent not in pool
                assert len(pool & ours) >= MIN_PER_STEP, (service, step.number)
                assert pool <= ours, (service, step.number)

    run_db(database_url, check)
    # Повторная загрузка ничего не дублирует.
    seed_training(database_url)

    async def count(db):
        return len(list(await db.scalars(select(Scenario.id).where(Scenario.id.in_(ours)))))

    assert run_db(database_url, count) == len(ours)


def test_step_two_and_three_issue_practice_scenarios(database_config, database_url, monkeypatch):
    seed_training(database_url)

    async def history(db, user_id):
        levels = [(1, True)] + [(1, False)] * 3
        return [StepAttempt(level, tutorial, True, T0) for level, tutorial in levels]

    monkeypatch.setattr("app.api.progress.service.trainee_attempts", history)
    ours = practice_ids()
    with TestClient(create_database_app(database_config)) as client:
        headers = login(client, "trainee02")
        previous = None
        for step in (2, 2, 3, 3):
            session = practice(client, headers, step)
            [(level, tutorial, service)] = issued(database_url, session["id"])
            assert (level, tutorial, service) == (step - 1, False, "101")

            async def scenario(db, session_id=session["id"]):
                return await db.scalar(
                    select(Assignment.scenario_id).where(Assignment.session_id == UUID(session_id))
                )

            issued_id = run_db(database_url, scenario)
            assert issued_id in ours
            # Подряд та же карточка не выпадает: прошлый сценарий уступает свежим.
            assert issued_id != previous
            previous = issued_id
