import asyncio
import json
from copy import deepcopy

import pytest
from app.core.config import ROOT, Settings
from app.worker.generators.validation import (
    GenerationRejected,
    validate_facts,
    validate_response,
    with_victims,
)
from app.worker.runtime import Worker


def cases():
    return json.loads((ROOT / "data/scenario-generation-cases.json").read_text())


def valid_response(facts):
    final = facts["reports"][-1]["options"][0]
    return {
        "status": "ready",
        "facts": {key: facts[key] for key in ("service", "address", "victims", "outcome")},
        "caller_name": facts["caller_name"],
        "description": f"{facts['address']}. {facts['situation']}",
        "tags": ["Учебное задание"],
        "choices": {r["state"]: r["options"][0] for r in facts["reports"]},
        "expected_comment": (
            f"{facts['address']}. {facts['situation']} {final} "
            + ("Работы не проводились." if facts["outcome"] == "refused" else "Работы завершены.")
        ),
    }


def test_completed_and_refused_are_reachable_and_contradictory_input_is_rejected():
    for case in cases()[:2]:
        validate_facts(case["facts"])
        validate_response(case["facts"], valid_response(case["facts"]))
    with pytest.raises(GenerationRejected, match="противоречит"):
        validate_response(cases()[2]["facts"], valid_response(cases()[2]["facts"]))


@pytest.mark.parametrize(
    "defect", ["address", "service", "victims", "foreign_phrase", "invented_number", "outcome"]
)
def test_response_cannot_change_facts_or_state_sequence(defect):
    facts = deepcopy(cases()[1]["facts"])
    response = valid_response(facts)
    if defect in {"address", "service", "victims"}:
        response["facts"][defect] = {
            "address": "Москва, другая улица, дом 9",
            "service": "102",
            "victims": True,
        }[defect]
    elif defect == "foreign_phrase":
        # Фраза не из предложенных банком: модель не может написать доклад сама.
        response["choices"]["arrived"] = "Прибыли, всё сгорело, трое погибших."
    elif defect == "invented_number":
        response["description"] += " Квартира 999."
    else:
        response["expected_comment"] += " Работы завершены."
    with pytest.raises(GenerationRejected):
        validate_response(facts, response)


def test_refusal_cannot_include_assignable_plan():
    facts = cases()[0]["facts"]
    response = {
        "status": "refused",
        "reason": "Недостаточно исходных фактов.",
        "choices": valid_response(facts)["choices"],
    }
    with pytest.raises(GenerationRejected, match="схеме"):
        validate_response(facts, response)


@pytest.mark.parametrize("addition", [" Подгорела еда.", " Работы завершены.", " Вызвали полицию."])
def test_initial_description_cannot_reveal_outcome_or_invent_service(addition):
    facts = deepcopy(cases()[1]["facts"])
    response = valid_response(facts)
    response["description"] += addition
    with pytest.raises(GenerationRejected):
        validate_response(facts, response)


def test_generator_settings_do_not_change_local_judge():
    async def check():
        config = Settings(
            _env_file=None,
            ai_provider="local",
            generation_timeout_seconds=179,
            generation_max_tokens=1535,
        )
        worker = Worker(config)
        try:
            assert worker.handlers.llm.max_tokens == 1535
            assert worker.handlers.llm.timeout_seconds == 179
            assert worker.handlers.judge.max_tokens == 300
            assert worker.handlers.judge.timeout_seconds == 120
            assert worker.handlers.judge.model == config.llm_model
            assert (
                worker.handlers.judge.system_prompt
                == (ROOT / "apps/api/app/worker/prompts/comment_judge_system.md")
                .read_text()
                .strip()
            )
            assert worker.handlers.judge.schema == json.loads(
                (ROOT / "apps/api/app/worker/prompts/comment_judge.schema.json").read_text()
            )
        finally:
            await worker.close()

    asyncio.run(check())


@pytest.mark.parametrize("word", ["устранения", "устранение", "устранены"])
def test_eliminating_a_fault_does_not_invent_injuries(word):
    facts = cases()[0]["facts"]
    response = valid_response(facts)
    response["expected_comment"] += f" Результат {word} неисправности подтверждён."
    validate_response(facts, response)


@pytest.mark.parametrize(
    "addition", [" Есть раненые.", " Нужна госпитализация.", " Диагноз уточнён."]
)
def test_real_unprovided_medical_facts_are_still_rejected(addition):
    facts = cases()[0]["facts"]
    response = valid_response(facts)
    response["expected_comment"] += addition
    with pytest.raises(GenerationRejected, match="пострадавших"):
        validate_response(facts, response)


def test_restoration_is_completed_but_future_work_is_not():
    facts = cases()[0]["facts"]
    response = valid_response(facts)
    response["expected_comment"] = (
        "Подача холодной воды в квартире восстановлена. Пострадавших нет."
    )
    validate_response(facts, response)
    response["expected_comment"] = "Подача холодной воды в квартире будет восстановлена."
    with pytest.raises(GenerationRejected, match="будущая работа"):
        validate_response(facts, response)


@pytest.mark.parametrize(
    ("description", "victims", "expected"),
    [
        ("Москва, дом 1: ребёнку плохо. Пострадавших есть.", True, "Есть пострадавшие."),
        ("Москва, дом 1: нет воды.", False, "Пострадавших нет."),
        ("Москва, дом 1: нет воды. Пострадавших нет.", False, "Пострадавших нет."),
    ],
)
def test_victims_sentence_is_set_by_code(description, victims, expected):
    # Признак пострадавших — факт сюжета: ставит код, неграмотная форма модели заменяется.
    result = with_victims(description, victims)
    assert result.endswith(expected) and result.count("острадавш") == 1


def test_description_cannot_contradict_victims():
    facts = deepcopy(cases()[0]["facts"])
    response = valid_response(facts)
    response["description"] = (
        f"{facts['address']}: в квартире нет воды, есть пострадавшие у соседей."
    )
    with pytest.raises(GenerationRejected, match="пострадавших"):
        validate_response(facts, response)


def test_response_schema_pins_input_and_offers_only_bank_phrases():
    from app.worker.generators.validation import response_schema

    facts = cases()[0]["facts"]
    schema = response_schema(facts)
    assert len(schema["anyOf"]) == 1
    ready = schema["anyOf"][0]["properties"]
    assert ready["facts"]["properties"]["address"] == {"const": facts["address"]}
    assert ready["caller_name"] == {"const": facts["caller_name"]}
    for report in facts["reports"]:
        assert ready["choices"]["properties"][report["state"]]["enum"] == report["options"]
