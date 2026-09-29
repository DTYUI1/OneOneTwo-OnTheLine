"""Локальный ИИ-судья через OpenAI-совместимый llama.cpp (выбранная модель Qwen3-4B).

Модель только классифицирует заданные ключевые факты и оценивает понятность: полноту
считает код. Ответ с выдуманным или пропущенным фактом, вне схемы или без пояснения
отклоняется — вызывающий код сохраняет rules-оценку и partial (C-06).
"""

import json
import logging
import re
from pathlib import Path
from typing import Any

import httpx
from jsonschema import Draft202012Validator

from app.worker.providers.judge.base import JudgeRequest, JudgeVerdict

logger = logging.getLogger(__name__)


def prompt(request: JudgeRequest) -> str:
    """Данные для модели одним JSON: текст обучаемого — значение поля, не инструкция."""
    return json.dumps(
        {
            "incident": request.incident,
            "key_facts": request.key_facts,
            "trainee_comment": request.comment,
            "teacher_examples": [
                {
                    "comment": item.comment,
                    "teacher_decision": item.decision,
                    "teacher_total": item.teacher_total,
                    "teacher_reason": item.reason,
                }
                for item in request.few_shot
            ],
        },
        ensure_ascii=False,
    )


def _stems(value: str) -> set[str]:
    words = re.findall(r"[а-яa-z]+", value.casefold().replace("ё", "е"))
    return {word[:5] for word in words if len(word) >= 4}


def grounded(fact: str, comment: str) -> bool:
    """Факт подтверждён текстом: есть общая основа слова, для адреса — и номер дома."""
    content = fact.split(":", 1)[-1]
    if not _stems(content) & _stems(comment):
        return False
    numbers = re.findall(r"\d+", content)
    return all(number in re.findall(r"\d+", comment) for number in numbers)


def verdict(request: JudgeRequest, result: dict[str, Any]) -> JudgeVerdict:
    found, missing = list(result["facts_found"]), list(result["facts_missing"])
    expected = set(request.key_facts)
    if set(found) & set(missing) or set(found) | set(missing) != expected:
        raise ValueError("Судья должен разложить ровно заданные факты")
    if len(found) + len(missing) != len(expected):
        raise ValueError("Факт указан дважды")
    # Небольшая модель иногда «находит» факт без опоры в тексте: такой факт — отсутствует.
    unsupported = [fact for fact in found if not grounded(fact, request.comment)]
    found = [fact for fact in found if fact not in unsupported]
    missing = [fact for fact in request.key_facts if fact not in found]
    return JudgeVerdict(found, missing, float(result["clarity"]), result["explanation"].strip())


class LocalLlamaJudge:
    def __init__(
        self,
        *,
        base_url: str,
        model: str,
        prompt_path: Path,
        schema_path: Path,
        timeout_seconds: float,
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
        self.max_tokens = max_tokens
        self.transport = transport

    async def assess(self, request: JudgeRequest) -> JudgeVerdict | None:
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": self.system_prompt},
                {"role": "user", "content": prompt(request)},
            ],
            # Детерминированность: одна и та же попытка — один и тот же вердикт.
            "temperature": 0,
            "seed": 112,
            "max_tokens": self.max_tokens,
            "cache_prompt": True,
            "response_format": {"type": "json_schema", "schema": self.schema},
        }
        try:
            async with httpx.AsyncClient(
                timeout=self.timeout_seconds, transport=self.transport
            ) as client:
                response = await client.post(f"{self.base_url}/chat/completions", json=body)
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            result = json.loads(content)
            if not isinstance(result, dict) or any(self.validator.iter_errors(result)):
                raise ValueError("Ответ судьи не соответствует схеме")
            return verdict(request, result)
        except (httpx.HTTPError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            logger.warning(
                "ИИ-судья недоступен или вернул непроверяемый ответ; оценка остаётся partial.",
                extra={"error_type": type(exc).__name__, "model": self.model},
            )
            return None
