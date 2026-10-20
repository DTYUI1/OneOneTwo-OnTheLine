import asyncio
import json

import httpx
from app.core.config import ROOT
from app.worker.providers.llm.local_llamacpp import LocalLlamaCpp

FACTS = {
    "incident_type_code": "2020000",
    "incident_class": "ДТП с пострадавшими",
    "address": {"street": "Дубнинская улица", "house": "1"},
    "victims": True,
    "ambulance_refused": False,
    "blocked_people": False,
    "emergency": False,
    "complications": [],
}


def provider(transport: httpx.AsyncBaseTransport) -> LocalLlamaCpp:
    return LocalLlamaCpp(
        base_url="http://llm.test/v1",
        model="qwen3-4b-2507-q4km",
        prompt_path=ROOT / "apps/api/app/worker/prompts/scenario_narrative_system.md",
        schema_path=ROOT / "contracts/scenario-narrative.schema.json",
        timeout_seconds=1,
        temperature=0.2,
        max_tokens=300,
        transport=transport,
    )


def response_content(description: str) -> dict:
    content = {
        "caller_name": "Иван Петров",
        "description": description,
        "tags": ["ДТП", "пострадавшие"],
    }
    return {"choices": [{"message": {"content": json.dumps(content, ensure_ascii=False)}}]}


def test_local_qwen_uses_schema_and_accepts_grounded_json():
    schema = json.loads((ROOT / "contracts/scenario-narrative.schema.json").read_text("utf-8"))

    def handle(request: httpx.Request) -> httpx.Response:
        assert request.url == "http://llm.test/v1/chat/completions"
        body = json.loads(request.content)
        assert body["model"] == "qwen3-4b-2507-q4km"
        assert "response_format" not in body
        assert body["json_schema"] == schema
        assert json.loads(body["messages"][1]["content"]) == FACTS
        return httpx.Response(
            200,
            json=response_content(
                "Заявитель сообщает: ДТП с пострадавшими произошло по адресу "
                "Дубнинская улица, дом 1. Другие обстоятельства в учебных данных не указаны."
            ),
        )

    result = asyncio.run(
        provider(httpx.MockTransport(handle)).complete_json(
            json.dumps(FACTS, ensure_ascii=False, sort_keys=True)
        )
    )
    assert result is not None
    assert result["caller_name"] == "Иван Петров"


def test_local_qwen_rejects_invented_numeric_fact_and_falls_back():
    def handle(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json=response_content(
                "Заявитель сообщает: ДТП с пострадавшими произошло по адресу "
                "Дубнинская улица, дом 1, квартира 99. Другие обстоятельства не указаны."
            ),
        )

    result = asyncio.run(
        provider(httpx.MockTransport(handle)).complete_json(
            json.dumps(FACTS, ensure_ascii=False, sort_keys=True)
        )
    )
    assert result is None


def test_local_qwen_http_error_falls_back_without_job_failure():
    transport = httpx.MockTransport(lambda request: httpx.Response(503))
    result = asyncio.run(
        provider(transport).complete_json(json.dumps(FACTS, ensure_ascii=False, sort_keys=True))
    )
    assert result is None


def test_only_transient_provider_errors_are_retryable():
    for status, retryable in [(400, False), (401, False), (404, False), (429, True), (503, True)]:
        llm = provider(httpx.MockTransport(lambda request, status=status: httpx.Response(status)))
        assert asyncio.run(llm.complete_json(json.dumps(FACTS))) is None
        assert llm.last_diagnostics["retryable"] is retryable

    def timeout(request):
        raise httpx.ReadTimeout("timeout", request=request)

    llm = provider(httpx.MockTransport(timeout))
    assert asyncio.run(llm.complete_json(json.dumps(FACTS))) is None
    assert llm.last_diagnostics["retryable"] is True
