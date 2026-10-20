"""Воспроизводимый прогон A: сохраняет ввод, исходный ответ и независимую проверку."""

import argparse
import asyncio
import json
import logging
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

from app.core.config import ROOT, Settings
from app.worker.generators.validation import (
    PROMPT_VERSION,
    GenerationRejected,
    response_schema,
    response_validator,
    validate_facts,
    validate_response,
)

logger = logging.getLogger(__name__)


def save(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


async def probe(args: argparse.Namespace) -> bool:
    config = Settings()
    prompt = (ROOT / "apps/api/app/worker/prompts/scenario_generation_system.md").read_text()
    schema = response_validator().schema
    directory = args.output_dir / datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
    directory.mkdir(parents=True)
    (directory / "system-prompt.md").write_text(prompt, encoding="utf-8")
    save(directory / "schema.json", schema)
    cases = json.loads(args.cases.read_text(encoding="utf-8"))
    summaries = []
    async with httpx.AsyncClient(timeout=config.generation_timeout_seconds) as client:
        for case in cases:
            facts = case["facts"]
            # Схема под вход: факты закреплены, выбор — одна из фраз банка доклада.
            case_schema = response_schema(facts)
            request = {
                "model": config.llm_model,
                "messages": [
                    {"role": "system", "content": prompt},
                    {"role": "user", "content": json.dumps(facts, ensure_ascii=False)},
                ],
                "temperature": config.llm_temperature,
                "seed": 112,
                "max_tokens": config.generation_max_tokens,
                "cache_prompt": True,
                "json_schema": case_schema,
            }
            prefix = directory / case["id"]
            save(prefix.with_suffix(".input.json"), request)
            summary: dict[str, Any] = {
                "case": case["id"],
                "expected": case["expected"],
                "prompt_version": PROMPT_VERSION,
                "timeout_seconds": config.generation_timeout_seconds,
                "max_tokens": config.generation_max_tokens,
                "attempt": 1,
            }
            try:
                validate_facts(facts)
                summary["server_input_valid"] = True
            except GenerationRejected as exc:
                summary.update(server_input_valid=False, server_input_error=str(exc))
            started = time.monotonic()
            try:
                # Третий вход намеренно доходит до модели, хотя сервер его уже отклонил.
                response = await client.post(
                    f"{args.base_url.rstrip('/')}/chat/completions", json=request
                )
                summary["duration_seconds"] = round(time.monotonic() - started, 3)
                prefix.with_suffix(".http.txt").write_text(response.text, encoding="utf-8")
                response.raise_for_status()
                raw = response.json()
                content = raw["choices"][0]["message"]["content"]
                prefix.with_suffix(".response.txt").write_text(content, encoding="utf-8")
                summary.update(
                    usage=raw.get("usage"),
                    timings=raw.get("timings"),
                    finish_reason=raw["choices"][0].get("finish_reason"),
                )
                value = json.loads(content)
                summary["schema_valid"] = response_validator().is_valid(value)
                summary["model_status"] = value.get("status")
                prompt_tokens = (raw.get("usage") or {}).get("prompt_tokens")
                summary["context_budget_valid"] = (
                    isinstance(prompt_tokens, int)
                    and prompt_tokens + config.generation_max_tokens <= 4096
                )
                if summary["server_input_valid"]:
                    validate_response(facts, value)
                    summary["domain_valid"] = True
                else:
                    summary["domain_valid"] = False
                summary["passed"] = (
                    summary["schema_valid"]
                    and summary["context_budget_valid"]
                    and value.get("status") == case["expected"]
                    and (summary["domain_valid"] or case["expected"] == "refused")
                )
            except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
                summary.update(
                    passed=False,
                    error=str(exc),
                    duration_seconds=round(time.monotonic() - started, 3),
                )
            save(prefix.with_suffix(".validation.json"), summary)
            summaries.append(summary)
            logger.info("%s", json.dumps(summary, ensure_ascii=False))
    save(directory / "summary.json", summaries)
    logger.info("Артефакты: %s", directory)
    return all(item["passed"] for item in summaries)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:47902/v1")
    parser.add_argument("--cases", type=Path, default=ROOT / "data/scenario-generation-cases.json")
    parser.add_argument(
        "--output-dir", type=Path, default=ROOT / "tmp/ai-scenario-generation/stage-a"
    )
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    raise SystemExit(0 if asyncio.run(probe(parser.parse_args())) else 1)


if __name__ == "__main__":
    main()
