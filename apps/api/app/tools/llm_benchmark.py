"""Reproducible local-LLM benchmark for scenario narrative generation."""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import platform
import re
import statistics
import sys
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from jsonschema import Draft202012Validator

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_SCHEMA = REPOSITORY_ROOT / "contracts" / "scenario-narrative.schema.json"
DEFAULT_PROMPT = (
    REPOSITORY_ROOT / "apps" / "api" / "app" / "worker" / "prompts" / "scenario_narrative_system.md"
)
DEFAULT_CASES = REPOSITORY_ROOT / "data" / "golden_scenarios"
DEFAULT_OUTPUT = REPOSITORY_ROOT / "tmp" / "llm-benchmark"

COMPLICATION_LABELS = {
    "duplicate": "возможный повторный вызов",
    "emergency": "экстренная ситуация",
    "no_contact": "после исходного сообщения связь с заявителем недоступна",
    "no_phone": "номер телефона заявителя не определён",
    "parallel": "карточка поступает одновременно с другой",
    "wrong_address": "адрес записан со слов заявителя и может требовать уточнения",
}


@dataclass(frozen=True)
class BenchmarkCase:
    case_id: str
    facts: dict[str, Any]
    expected_incident_class: str
    expected_street: str
    expected_house: str


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def load_cases(directory: Path, limit: int | None = None) -> list[BenchmarkCase]:
    cases: list[BenchmarkCase] = []
    for path in sorted(directory.glob("*.json")):
        source = _read_json(path)
        scenario = source["scenario"]
        card = scenario["card"]
        address = card["address"]
        complications = [
            COMPLICATION_LABELS.get(value, value) for value in scenario.get("complications", [])
        ]
        cases.append(
            BenchmarkCase(
                case_id=str(source["id"]),
                facts={
                    "incident_type_code": card["incident_type_code"],
                    "incident_class": card["incident_class"],
                    "address": address,
                    "victims": card["victims"],
                    "ambulance_refused": card["ambulance_refused"],
                    "blocked_people": card["blocked_people"],
                    "emergency": card["emergency"],
                    "complications": complications,
                },
                expected_incident_class=str(card["incident_class"]),
                expected_street=str(address["street"]),
                expected_house=str(address["house"]),
            )
        )
        if limit is not None and len(cases) >= limit:
            break
    if not cases:
        raise ValueError(f"В {directory} не найдено тест-кейсов JSON")
    return cases


def normalize_words(value: str) -> set[str]:
    normalized = value.casefold().replace("ё", "е")
    return {word for word in re.findall(r"[\w-]+", normalized) if len(word) > 1}


def phrase_words_present(expected: str, actual: str) -> bool:
    expected_words = normalize_words(expected)
    actual_words = normalize_words(actual)
    if not expected_words:
        return False
    for expected_word in expected_words:
        if expected_word in actual_words:
            continue
        # Russian case endings commonly change the last 1–3 characters. Require a
        # long common prefix so this remains a fact-presence check, not fuzzy matching.
        if not any(
            len(expected_word) >= 5
            and len(actual_word) >= 5
            and len(os.path.commonprefix([expected_word, actual_word]))
            >= max(4, min(len(expected_word), len(actual_word)) - 2)
            for actual_word in actual_words
        ):
            return False
    return True


def evaluate_content(
    content: str,
    case: BenchmarkCase,
    validator: Draft202012Validator,
) -> dict[str, Any]:
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as exc:
        return {
            "valid_json": False,
            "valid_schema": False,
            "schema_errors": [str(exc)],
            "fact_checks": {},
            "fact_coverage": 0.0,
            "cyrillic_ratio": 0.0,
        }

    schema_errors = sorted(error.message for error in validator.iter_errors(parsed))
    description = parsed.get("description", "") if isinstance(parsed, dict) else ""
    if not isinstance(description, str):
        description = ""
    normalized_description = description.casefold().replace("ё", "е")
    house = re.escape(case.expected_house.casefold())
    fact_checks = {
        "incident_class": phrase_words_present(case.expected_incident_class, description),
        "street": phrase_words_present(case.expected_street, description),
        "house": bool(re.search(rf"\b(?:дом|д)\.?\s*{house}\b", normalized_description)),
    }
    if case.facts.get("emergency"):
        fact_checks["emergency"] = bool(
            re.search(r"\b(?:экстренн\w*|чрезвычайн\w*)\b", normalized_description)
        )
    alphabetic = [character for character in description if character.isalpha()]
    cyrillic = [character for character in alphabetic if "а" <= character.casefold() <= "я"]
    return {
        "valid_json": True,
        "valid_schema": not schema_errors,
        "schema_errors": schema_errors,
        "fact_checks": fact_checks,
        "fact_coverage": sum(fact_checks.values()) / len(fact_checks),
        "cyrillic_ratio": len(cyrillic) / len(alphabetic) if alphabetic else 0.0,
    }


def percentile(values: list[float], percentile_value: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, math.ceil(percentile_value * len(ordered)) - 1)
    return ordered[index]


def summarize_results(
    results: list[dict[str, Any]],
    *,
    latency_limit_seconds: float,
    speed_floor_tokens_per_second: float,
) -> dict[str, Any]:
    total = len(results)
    successful = [result for result in results if result.get("http_success")]
    latencies = [float(result["latency_seconds"]) for result in successful]
    speeds = [
        float(result["predicted_tokens_per_second"])
        for result in successful
        if result.get("predicted_tokens_per_second") is not None
    ]
    schema_rate = (
        sum(bool(result.get("valid_schema")) for result in successful) / total if total else 0.0
    )
    json_rate = (
        sum(bool(result.get("valid_json")) for result in successful) / total if total else 0.0
    )
    fact_coverages = [float(result.get("fact_coverage", 0.0)) for result in successful]
    fact_mean = statistics.fmean(fact_coverages) if fact_coverages else 0.0
    fact_min = min(fact_coverages, default=0.0)
    p95 = percentile(latencies, 0.95)
    speed_median = statistics.median(speeds) if speeds else None
    automatic_gate = (
        len(successful) == total
        and schema_rate == 1.0
        and fact_mean >= 0.95
        and fact_min >= 0.80
        and p95 is not None
        and p95 <= latency_limit_seconds
        and speed_median is not None
        and speed_median >= speed_floor_tokens_per_second
    )
    return {
        "requests": total,
        "http_success_rate": len(successful) / total if total else 0.0,
        "valid_json_rate": json_rate,
        "valid_schema_rate": schema_rate,
        "fact_coverage_mean": fact_mean,
        "fact_coverage_min": fact_min,
        "latency_seconds_p50": statistics.median(latencies) if latencies else None,
        "latency_seconds_p95": p95,
        "predicted_tokens_per_second_p50": speed_median,
        "automatic_gate": automatic_gate,
        "manual_review_required": True,
    }


def _safe_label(value: str) -> str:
    label = re.sub(r"[^a-zA-Z0-9_.-]+", "-", value).strip("-")
    return label or "model"


def _report_markdown(metadata: dict[str, Any], summary: dict[str, Any]) -> str:
    value = lambda item: "n/a" if item is None else f"{item:.3f}"  # noqa: E731
    gate = "PASS" if summary["automatic_gate"] else "FAIL"
    run_shape = f"{metadata['runs']} / {metadata['case_count']} / {metadata['concurrency']}"
    fact_coverage = f"{summary['fact_coverage_mean']:.1%} / {summary['fact_coverage_min']:.1%}"
    latency = f"{value(summary['latency_seconds_p50'])} / {value(summary['latency_seconds_p95'])}"
    return f"""# LLM benchmark: {metadata["label"]}

- UTC: `{metadata["started_at"]}`
- endpoint: `{metadata["base_url"]}`
- model: `{metadata["model"]}`
- hardware: `{metadata["hardware_label"]}`
- runs/cases/concurrency: `{run_shape}`
- automatic gate: **{gate}**

| Metric | Value |
|---|---:|
| HTTP success | {summary["http_success_rate"]:.1%} |
| Valid JSON | {summary["valid_json_rate"]:.1%} |
| Valid schema | {summary["valid_schema_rate"]:.1%} |
| Fact coverage mean / min | {fact_coverage} |
| Latency p50 / p95, s | {latency} |
| Generation speed p50, tok/s | {value(summary["predicted_tokens_per_second_p50"])} |

Автоматический PASS не выбирает модель окончательно. Откройте соседний JSONL и вручную оцените
каждый уникальный ответ: русский язык, реалистичность, отсутствие выдуманных фактов и пригодность
для учебной карточки. Любая опасная галлюцинация исключает модель независимо от среднего балла.
"""


async def _generate_one(
    client: httpx.AsyncClient,
    semaphore: asyncio.Semaphore,
    *,
    base_url: str,
    model: str,
    system_prompt: str,
    schema: dict[str, Any],
    case: BenchmarkCase,
    run: int,
    seed: int,
    temperature: float,
    max_tokens: int,
    validator: Draft202012Validator,
) -> dict[str, Any]:
    request_body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": json.dumps(case.facts, ensure_ascii=False, sort_keys=True),
            },
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "seed": seed,
        "cache_prompt": True,
        "response_format": {"type": "json_schema", "schema": schema},
    }
    # Measure service latency only after the request acquires a concurrency
    # slot.  Tasks are created together, so measuring before the semaphore
    # would count queue wait as request latency and inflate c=1 p95.
    started = time.perf_counter()
    try:
        async with semaphore:
            started = time.perf_counter()
            response = await client.post(
                f"{base_url.rstrip('/')}/chat/completions", json=request_body
            )
        latency = time.perf_counter() - started
        response.raise_for_status()
        payload = response.json()
        content = payload["choices"][0]["message"]["content"]
        if not isinstance(content, str):
            raise TypeError("choices[0].message.content не является строкой")
        evaluation = evaluate_content(content, case, validator)
        timings = payload.get("timings") or {}
        usage = payload.get("usage") or {}
        return {
            "case_id": case.case_id,
            "run": run,
            "seed": seed,
            "http_success": True,
            "latency_seconds": latency,
            "prompt_tokens": usage.get("prompt_tokens"),
            "completion_tokens": usage.get("completion_tokens"),
            "cached_prompt_tokens": (usage.get("prompt_tokens_details") or {}).get("cached_tokens"),
            "predicted_tokens_per_second": timings.get("predicted_per_second"),
            "content": content,
            **evaluation,
        }
    except (httpx.HTTPError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        return {
            "case_id": case.case_id,
            "run": run,
            "seed": seed,
            "http_success": False,
            "latency_seconds": time.perf_counter() - started,
            "error": f"{type(exc).__name__}: {exc}",
            "valid_json": False,
            "valid_schema": False,
            "fact_coverage": 0.0,
        }


async def run_benchmark(args: argparse.Namespace) -> tuple[Path, Path, dict[str, Any]]:
    schema = _read_json(args.schema)
    validator = Draft202012Validator(schema)
    validator.check_schema(schema)
    system_prompt = args.prompt.read_text(encoding="utf-8").strip()
    cases = load_cases(args.cases, args.case_limit)
    hardware_label = args.hardware_label or (
        f"{platform.processor() or platform.machine()}, {os.cpu_count()} logical CPU, "
        f"{platform.system()} {platform.release()}"
    )
    metadata = {
        "label": args.label,
        "model": args.model,
        "base_url": args.base_url.rstrip("/"),
        "hardware_label": hardware_label,
        "runs": args.runs,
        "case_count": len(cases),
        "concurrency": args.concurrency,
        "temperature": args.temperature,
        "max_tokens": args.max_tokens,
        "started_at": datetime.now(UTC).isoformat(),
    }
    semaphore = asyncio.Semaphore(args.concurrency)
    timeout = httpx.Timeout(args.timeout)
    async with httpx.AsyncClient(timeout=timeout) as client:
        if args.warmup:
            await _generate_one(
                client,
                semaphore,
                base_url=args.base_url,
                model=args.model,
                system_prompt=system_prompt,
                schema=schema,
                case=cases[0],
                run=-1,
                seed=args.seed,
                temperature=args.temperature,
                max_tokens=args.max_tokens,
                validator=validator,
            )
        tasks = [
            _generate_one(
                client,
                semaphore,
                base_url=args.base_url,
                model=args.model,
                system_prompt=system_prompt,
                schema=schema,
                case=case,
                run=run,
                seed=args.seed + run,
                temperature=args.temperature,
                max_tokens=args.max_tokens,
                validator=validator,
            )
            for run in range(1, args.runs + 1)
            for case in cases
        ]
        results = await asyncio.gather(*tasks)

    summary = summarize_results(
        results,
        latency_limit_seconds=args.latency_limit,
        speed_floor_tokens_per_second=args.speed_floor,
    )
    args.output_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    stem = f"{stamp}-{_safe_label(args.label)}-c{args.concurrency}"
    jsonl_path = args.output_dir / f"{stem}.jsonl"
    report_path = args.output_dir / f"{stem}.md"
    with jsonl_path.open("w", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps({"type": "metadata", **metadata}, ensure_ascii=False) + "\n")
        for result in results:
            stream.write(
                json.dumps({"type": "result", **result}, ensure_ascii=False, sort_keys=True) + "\n"
            )
        stream.write(
            json.dumps({"type": "summary", **summary}, ensure_ascii=False, sort_keys=True) + "\n"
        )
    report_path.write_text(_report_markdown(metadata, summary), encoding="utf-8", newline="\n")
    return jsonl_path, report_path, summary


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Сравнимый бенчмарк OpenAI-compatible LLM для нарратива сценариев"
    )
    parser.add_argument("--base-url", default="http://127.0.0.1:8080/v1")
    parser.add_argument("--model", default="local-model")
    parser.add_argument("--label", required=True, help="Короткое имя модели и кванта")
    parser.add_argument("--schema", type=Path, default=DEFAULT_SCHEMA)
    parser.add_argument("--prompt", type=Path, default=DEFAULT_PROMPT)
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--case-limit", type=int)
    parser.add_argument("--concurrency", type=int, choices=(1, 2), default=1)
    parser.add_argument("--temperature", type=float, default=0.2)
    parser.add_argument("--max-tokens", type=int, default=300)
    parser.add_argument("--seed", type=int, default=112)
    parser.add_argument("--timeout", type=float, default=180.0)
    parser.add_argument("--latency-limit", type=float, default=45.0)
    parser.add_argument("--speed-floor", type=float, default=3.0)
    parser.add_argument("--hardware-label")
    parser.add_argument("--no-warmup", action="store_false", dest="warmup")
    parser.set_defaults(warmup=True)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if args.runs < 1:
        parser.error("--runs должен быть >= 1")
    jsonl_path, report_path, summary = asyncio.run(run_benchmark(args))
    print(f"raw={jsonl_path}")
    print(f"report={report_path}")
    print(f"automatic_gate={'PASS' if summary['automatic_gate'] else 'FAIL'}")
    return 0 if summary["automatic_gate"] else 2


if __name__ == "__main__":
    sys.exit(main())
