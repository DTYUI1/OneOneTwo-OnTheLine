import asyncio
import json

import httpx
from app.tools.llm_benchmark import (
    DEFAULT_SCHEMA,
    BenchmarkCase,
    _generate_one,
    evaluate_content,
    load_cases,
    summarize_results,
)
from jsonschema import Draft202012Validator


def _case() -> BenchmarkCase:
    return BenchmarkCase(
        case_id="test-case",
        facts={"emergency": False},
        expected_incident_class="ДТП с пострадавшими",
        expected_street="Дубнинская улица",
        expected_house="1",
    )


def test_load_cases_uses_all_golden_scenarios() -> None:
    cases = load_cases(DEFAULT_SCHEMA.parents[1] / "data" / "golden_scenarios")

    assert len(cases) == 11
    assert cases[0].case_id == "case-1"
    assert cases[0].facts["incident_class"] == "ДТП с пострадавшими"


def test_evaluate_content_accepts_strict_grounded_json() -> None:
    schema = json.loads(DEFAULT_SCHEMA.read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema)
    content = json.dumps(
        {
            "caller_name": "Анна Петрова",
            "description": (
                "Заявитель сообщает о ДТП с пострадавшими. Происшествие случилось по адресу: "
                "Дубнинская улица, дом 1. Дополнительные обстоятельства пока неизвестны."
            ),
            "tags": ["ДТП", "пострадавшие"],
        },
        ensure_ascii=False,
    )

    result = evaluate_content(content, _case(), validator)

    assert result["valid_json"] is True
    assert result["valid_schema"] is True
    assert result["fact_coverage"] == 1.0
    assert result["cyrillic_ratio"] > 0.95


def test_evaluate_content_rejects_markdown_fence_and_missing_facts() -> None:
    schema = json.loads(DEFAULT_SCHEMA.read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema)

    fenced = evaluate_content('```json\n{"description": "текст"}\n```', _case(), validator)
    valid_but_ungrounded = evaluate_content(
        json.dumps(
            {
                "caller_name": "Анна Петрова",
                "description": "Произошло учебное событие. Обстоятельства пока неизвестны. " * 2,
                "tags": ["событие"],
            },
            ensure_ascii=False,
        ),
        _case(),
        validator,
    )

    assert fenced["valid_json"] is False
    assert valid_but_ungrounded["valid_schema"] is True
    assert valid_but_ungrounded["fact_coverage"] == 0.0


def test_summary_gate_requires_quality_and_performance() -> None:
    result = {
        "http_success": True,
        "valid_json": True,
        "valid_schema": True,
        "fact_coverage": 1.0,
        "latency_seconds": 4.0,
        "predicted_tokens_per_second": 8.0,
    }

    passed = summarize_results(
        [result, result], latency_limit_seconds=45.0, speed_floor_tokens_per_second=3.0
    )
    failed = summarize_results(
        [{**result, "valid_schema": False}],
        latency_limit_seconds=45.0,
        speed_floor_tokens_per_second=3.0,
    )

    assert passed["automatic_gate"] is True
    assert failed["automatic_gate"] is False


def test_generate_one_uses_llamacpp_json_schema_format() -> None:
    schema = json.loads(DEFAULT_SCHEMA.read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema)
    content = json.dumps(
        {
            "caller_name": "Анна Петрова",
            "description": (
                "Заявитель сообщает о ДТП с пострадавшими. Адрес происшествия: "
                "Дубнинская улица, дом 1. Остальные обстоятельства пока неизвестны."
            ),
            "tags": ["ДТП"],
        },
        ensure_ascii=False,
    )

    def handler(request: httpx.Request) -> httpx.Response:
        request_body = json.loads(request.content)
        assert request.url.path == "/v1/chat/completions"
        assert request_body["response_format"] == {"type": "json_schema", "schema": schema}
        assert request_body["cache_prompt"] is True
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": content}}],
                "usage": {"prompt_tokens": 100, "completion_tokens": 50},
                "timings": {"predicted_per_second": 7.5},
            },
        )

    async def call() -> dict[str, object]:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await _generate_one(
                client,
                asyncio.Semaphore(1),
                base_url="http://test/v1",
                model="test-model",
                system_prompt="test prompt",
                schema=schema,
                case=_case(),
                run=1,
                seed=112,
                temperature=0.2,
                max_tokens=300,
                validator=validator,
            )

    result = asyncio.run(call())

    assert result["http_success"] is True
    assert result["valid_schema"] is True
    assert result["fact_coverage"] == 1.0
    assert result["predicted_tokens_per_second"] == 7.5
