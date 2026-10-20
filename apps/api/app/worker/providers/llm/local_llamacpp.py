"""OpenAI-compatible llama.cpp provider for the selected local Qwen model."""

import hashlib
import json
import logging
import re
import time
from os.path import commonprefix
from pathlib import Path
from typing import Any

import httpx
from jsonschema import Draft202012Validator

from app.core.config import ROOT
from app.worker.generators.validation import (
    gameplay_schema,
    response_schema,
    validate_gameplay,
    validate_response,
)

# Генерация на каркасе сценария формата 2 (вход kind=gameplay): свой промпт и своя схема.
GAMEPLAY_PROMPT = ROOT / "apps/api/app/worker/prompts/scenario_gameplay_system.md"

logger = logging.getLogger(__name__)


def _words(value: str) -> set[str]:
    normalized = value.casefold().replace("ё", "е")
    return {word for word in re.findall(r"[\w-]+", normalized) if len(word) > 1}


def _phrase_present(expected: str, actual: str) -> bool:
    expected_words = _words(expected)
    actual_words = _words(actual)
    if not expected_words:
        return False
    for expected_word in expected_words:
        if expected_word in actual_words:
            continue
        if not any(
            len(expected_word) >= 5
            and len(actual_word) >= 5
            and len(commonprefix([expected_word, actual_word]))
            >= max(4, min(len(expected_word), len(actual_word)) - 2)
            for actual_word in actual_words
        ):
            return False
    return True


def _is_grounded(prompt: str, result: dict[str, Any]) -> bool:
    """Reject responses that omit required facts or invent numeric details."""
    try:
        facts = json.loads(prompt)
    except json.JSONDecodeError:
        return False
    if not isinstance(facts, dict):
        return False
    description = result.get("description")
    address = facts.get("address")
    incident = facts.get("incident_class") or facts.get("incident_type_code")
    if not isinstance(description, str) or not isinstance(address, dict):
        return False
    street, house = address.get("street"), address.get("house")
    if not all(isinstance(item, str) and item for item in (incident, street, house)):
        return False
    if not _phrase_present(str(incident), description) or not _phrase_present(
        str(street), description
    ):
        return False
    normalized = description.casefold().replace("ё", "е")
    if re.search(rf"\b(?:дом|д)\.?\s*{re.escape(str(house).casefold())}\b", normalized) is None:
        return False
    allowed_numbers = set(re.findall(r"\d+", prompt))
    return set(re.findall(r"\d+", description)).issubset(allowed_numbers)


class LocalLlamaCpp:
    is_generative = True

    def __init__(
        self,
        *,
        base_url: str,
        model: str,
        prompt_path: Path,
        schema_path: Path,
        timeout_seconds: float,
        temperature: float,
        max_tokens: int,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.name = f"local:{model}"
        self.system_prompt = prompt_path.read_text(encoding="utf-8").strip()
        self.schema = json.loads(schema_path.read_text(encoding="utf-8"))
        self.validator = Draft202012Validator(self.schema)
        self.validator.check_schema(self.schema)
        self.timeout_seconds = timeout_seconds
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.transport = transport
        self.full_scenario = self.schema.get("title") == "ScenarioGenerationResponse"
        self.last_diagnostics: dict[str, Any] = {}

    async def complete_json(self, prompt: str) -> dict[str, Any] | None:
        started = time.monotonic()
        self.last_diagnostics = {}
        seed = int.from_bytes(hashlib.sha256(prompt.encode("utf-8")).digest()[:4], "big")
        # Полный сценарий: схема под вход — закреплённые факты и номера фраз банка.
        facts = json.loads(prompt) if self.full_scenario else {}
        gameplay = facts.get("kind") == "gameplay"
        if gameplay:
            schema = gameplay_schema(facts)
            system = GAMEPLAY_PROMPT.read_text(encoding="utf-8").strip()
        else:
            schema = response_schema(facts) if self.full_scenario else self.schema
            system = self.system_prompt
        request = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "seed": seed,
            "cache_prompt": True,
            "json_schema": schema,
        }
        try:
            async with httpx.AsyncClient(
                timeout=self.timeout_seconds, transport=self.transport
            ) as client:
                response = await client.post(f"{self.base_url}/chat/completions", json=request)
            response.raise_for_status()
            raw = response.json()
            content = raw["choices"][0]["message"]["content"]
            self.last_diagnostics.update(
                usage=raw.get("usage"),
                raw_content=content,
                finish_reason=raw["choices"][0].get("finish_reason"),
            )
            if not isinstance(content, str):
                raise TypeError("choices[0].message.content должен быть строкой")
            result = json.loads(content)
            if not isinstance(result, dict):
                raise TypeError("Ответ модели должен быть JSON-объектом")
            # Схему каркаса проверяет validate_gameplay ниже: у неё своя форма ответа.
            errors = (
                []
                if gameplay
                else sorted(self.validator.iter_errors(result), key=lambda error: error.json_path)
            )
            if errors:
                raise ValueError("Ответ модели не соответствует JSON Schema")
            if gameplay:
                validate_gameplay(facts, result)
            elif self.full_scenario:
                validate_response(facts, result)
                prompt_tokens = (raw.get("usage") or {}).get("prompt_tokens")
                if isinstance(prompt_tokens, int) and prompt_tokens + self.max_tokens > 4096:
                    raise ValueError("Вход и резерв вывода превышают контекст 4096")
            elif not _is_grounded(prompt, result):
                raise ValueError("Ответ модели не прошёл проверку входных фактов")
            self.last_diagnostics["accepted"] = True
            return result
        except (httpx.HTTPError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            self.last_diagnostics.update(
                accepted=False,
                error=str(exc),
                retryable=isinstance(exc, httpx.TransportError)
                or (
                    isinstance(exc, httpx.HTTPStatusError)
                    and (exc.response.status_code in {408, 429} or exc.response.status_code >= 500)
                ),
            )
            logger.warning(
                "Локальная LLM недоступна или вернула небезопасный ответ; применён fallback.",
                extra={"error_type": type(exc).__name__, "model": self.model},
            )
            return None
        finally:
            self.last_diagnostics["duration_seconds"] = round(time.monotonic() - started, 3)
