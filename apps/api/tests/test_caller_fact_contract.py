"""Новые ссылки ожидания проверяются и в исходнике, и в публичном плане."""

import asyncio
import json
from uuid import uuid4

import pytest
from app.api.training.content import event_lines
from app.seed.scenarios import SCENARIOS_DIR, ScenarioFileError, training_plan, validate
from app.worker.generators.gameplay import SERVICES
from fastapi import HTTPException


@pytest.mark.parametrize("corruption", ("missing_relay", "wrong_brigade", "missing_fact"))
def test_source_rejects_invalid_caller_gate(corruption):
    data = json.loads((SCENARIOS_DIR / "pipe-access-gkh-2.json").read_text())
    gate = data["events"][0]["branches"]["met"]["awaits_call"]
    if corruption == "missing_relay":
        gate["relay_event"] = "not_in_this_plan"
    elif corruption == "wrong_brigade":
        data["brigades"].append({"key": "other", "ordinal": 1})
        data["events"][-1]["brigade"] = "other"
    else:
        gate["required_facts"] = ["not_in_this_plot"]
    with pytest.raises(ScenarioFileError):
        validate(data, data["code"], set(SERVICES))


@pytest.mark.parametrize("corruption", ("missing_relay", "wrong_brigade"))
def test_plan_rejects_invalid_caller_relay(corruption):
    data = json.loads((SCENARIOS_DIR / "pipe-access-gkh-2.json").read_text())

    async def no_audio(path, text):
        return None

    plan = asyncio.run(training_plan(data, no_audio))
    gate = plan["events"][0]["branches"]["met"]["awaits_call"]
    if corruption == "missing_relay":
        gate["relay_event"] = str(uuid4())
    else:
        plan["events"][-1]["brigade_id"] = str(uuid4())
    with pytest.raises(HTTPException) as caught:
        event_lines(plan["events"], {message["message"]["id"] for message in plan["messages"]})
    assert caught.value.status_code == 422
