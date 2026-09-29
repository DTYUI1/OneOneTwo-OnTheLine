"""OpenAI-compatible llama.cpp provider for the selected local Qwen model."""

import hashlib
import json
import logging
import re
from os.path import commonprefix
from pathlib import Path
from typing import Any

import httpx
from jsonschema import Draft202012Validator

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

    async def complete_json(self, prompt: str) -> dict[str, Any] | None:
        seed = int.from_bytes(hashlib.sha256(prompt.encode("utf-8")).digest()[:4], "big")
        request = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": self.system_prompt},
                {"role": "user", "content": prompt},
            ],
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "seed": seed,
            "cache_prompt": True,
            "response_format": {"type": "json_schema", "schema": self.schema},
        }
        try:
            async with httpx.AsyncClient(
                timeout=self.timeout_seconds, transport=self.transport
            ) as client:
                response = await client.post(f"{self.base_url}/chat/completions", json=request)
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            if not isinstance(content, str):
                raise TypeError("choices[0].message.content должен быть строкой")
            result = json.loads(content)
            if not isinstance(result, dict):
                raise TypeError("Ответ модели должен быть JSON-объектом")
            errors = sorted(self.validator.iter_errors(result), key=lambda error: error.json_path)
            if errors:
                raise ValueError("Ответ модели не соответствует JSON Schema")
            if not _is_grounded(prompt, result):
                raise ValueError("Ответ модели не прошёл проверку входных фактов")
            return result
        except (httpx.HTTPError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            logger.warning(
                "Локальная LLM недоступна или вернула небезопасный ответ; применён fallback.",
                extra={"error_type": type(exc).__name__, "model": self.model},
            )
            return None
