"""Ночной прогон: все сценарии × ветки × политики, отчёт и код выхода.

Засеянная БД готовится один раз и служит шаблоном; каждый процесс пула берёт её копию
(`harness.create_database`): прогоны не мешают друг другу и стенду. Часы — симуляции, пустые
тики пропускаются (`runner.ScenarioRun._world`). Отчёт — Markdown: сводка нарушений по
классам сверху, расшифровки прогонов с нарушениями ниже.
"""

import asyncio
import json
import multiprocessing
import os
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from app.seed.scenarios import SCENARIOS_DIR
from app.tools.coherence.harness import (
    PREFIX,
    SimClock,
    create_database,
    drop_prefixed,
    running_app,
    seed_scenarios_dir,
)
from app.tools.coherence.invariants import CATALOG, check, failing
from app.tools.coherence.policies import Policy, policies_for
from app.tools.coherence.runner import ScenarioRun

TRAINEE = "trainee01"


@dataclass(frozen=True)
class Job:
    code: str
    policy: Policy

    @property
    def weight(self) -> int:
        """Грубая длина прохода: длинные — в начало очереди, чтобы пул не ждал хвоста."""
        return len(self.policy.aims) + (0 if ":" in self.policy.name else 1)


@dataclass
class Result:
    code: str
    policy: str
    violations: list[tuple[str, float, str]]
    transcript: str
    closed: bool
    seconds: float

    @property
    def failed(self) -> bool:
        """Есть нарушение правила, которое не ждёт решения пользователя."""
        return any(failing(rule) for rule, _, _ in self.violations)


def load(directory: Path) -> dict[str, dict[str, Any]]:
    return {
        path.stem: json.loads(path.read_text(encoding="utf-8"))
        for path in sorted(directory.glob("*.json"))
    }


def plan_jobs(
    scenarios: dict[str, dict[str, Any]],
    codes: list[str] | None,
    policies: list[str] | None,
) -> list[Job]:
    jobs = []
    for code, data in scenarios.items():
        if codes and code not in codes:
            continue
        for policy in policies_for(data):
            if (
                policies
                and policy.name not in policies
                and not any(policy.name.startswith(f"{name}:") for name in policies)
            ):
                continue
            jobs.append(Job(code, policy))
    return jobs


async def run_job(app: Any, data: dict[str, Any], job: Job) -> Result:
    started = time.monotonic()
    try:
        tr = await ScenarioRun(app, SimClock(), data, job.policy, TRAINEE).run()
    except Exception as error:  # noqa: BLE001 — сбой прогона — тоже находка ночи
        return Result(
            job.code,
            job.policy.name,
            [("run_failed", 0.0, f"{type(error).__name__}: {error}")],
            "",
            False,
            time.monotonic() - started,
        )
    found = [(item.rule, item.at, item.detail) for item in check(tr)]
    return Result(
        job.code, job.policy.name, found, tr.render(), tr.closed, time.monotonic() - started
    )


# Процесс пула: своя БД (копия шаблона), свой цикл событий и приложение на все его проходы.
_process: dict[str, Any] = {}


def _start_process(source: str, template: str, prefix: str, directory: str) -> None:
    url = create_database(source, f"{prefix}{os.getpid()}", template)
    loop = asyncio.new_event_loop()
    running = running_app(url)
    app = loop.run_until_complete(running.__aenter__())
    _process.update(loop=loop, app=app, scenarios=load(Path(directory)))


def _run_in_process(job: Job) -> Result:
    loop: asyncio.AbstractEventLoop = _process["loop"]
    return loop.run_until_complete(run_job(_process["app"], _process["scenarios"][job.code], job))


def run_all(
    source: str,
    directory: Path = SCENARIOS_DIR,
    codes: list[str] | None = None,
    policies: list[str] | None = None,
    processes: int = 8,
    *,
    progress: bool = False,
) -> list[Result]:
    """Все проходы пулом процессов. Засеянная БД готовится один раз (шаблон), процессы берут
    её копию; проходы раздаются по одному — кто освободился, берёт следующий."""
    jobs = sorted(plan_jobs(load(directory), codes, policies), key=lambda j: -j.weight)
    if not jobs:
        return []
    prefix = f"{PREFIX}{uuid4().hex[:8]}_"
    template = create_database(source, prefix + "template")
    try:
        if directory != SCENARIOS_DIR:
            seed_scenarios_dir(template, directory)
        count = max(1, min(processes, len(jobs)))
        context = multiprocessing.get_context("spawn")
        results = []
        with context.Pool(
            count, initializer=_start_process, initargs=(source, template, prefix, str(directory))
        ) as pool:
            for index, result in enumerate(pool.imap_unordered(_run_in_process, jobs), 1):
                results.append(result)
                if progress:
                    mark = "!" if result.failed else "."
                    print(mark, end="\n" if index % 80 == 0 else "", flush=True)
        if progress:
            print()
        order = {(job.code, job.policy.name): index for index, job in enumerate(jobs)}
        results.sort(key=lambda item: (item.code, order[(item.code, item.policy)]))
        return results
    finally:
        drop_prefixed(source, prefix)


def report(results: list[Result], *, everything: bool = False) -> str:
    """Отчёт: сводка по классам, нарушения по прогонам, расшифровки."""
    stamp = datetime.now(UTC).astimezone().strftime("%Y-%m-%d %H:%M")
    by_rule: Counter[str] = Counter()
    runs_by_rule: dict[str, set[tuple[str, str]]] = defaultdict(set)
    example: dict[str, str] = {}
    for result in results:
        for rule, _, detail in result.violations:
            by_rule[rule] += 1
            runs_by_rule[rule].add((result.code, result.policy))
            example.setdefault(rule, f"{result.code} · {result.policy}: {detail}")
    bad = [result for result in results if result.violations]
    failed = [result for result in results if result.failed]
    scenarios = {result.code for result in results}
    hard = sum(count for rule, count in by_rule.items() if failing(rule))
    rows = [
        f"# Прогон связности мира — {stamp}",
        "",
        f"Сценариев: {len(scenarios)}, прогонов: {len(results)}, с нарушениями: {len(failed)}, "
        f"нарушений: {hard}. Ждут решения пользователя: "
        f"{sum(by_rule.values()) - hard} в {len(bad) - len(failed)} прогонах без других "
        "нарушений.",
        "",
        "## Сводка нарушений по классам",
        "",
    ]
    for title, wanted in (("", True), ("### Ждут решения пользователя", False)):
        chosen = [(rule, count) for rule, count in by_rule.most_common() if failing(rule) is wanted]
        if title:
            rows += ["", title, ""]
        if not chosen:
            rows.append("Нарушений нет." if wanted else "Нет.")
            continue
        rows.append("| Класс | Нарушений | Прогонов | Пример |")
        rows.append("|---|---|---|---|")
        for rule, count in chosen:
            rows.append(
                f"| `{rule}` | {count} | {len(runs_by_rule[rule])} | "
                f"{example[rule].replace('|', '/')} |"
            )
    rows += ["", "## Каталог инвариантов", ""]
    rows += [
        f"- `{item.id}` — {item.title}"
        + (f" (ждёт решения: {item.pending})" if item.pending else "")
        for item in CATALOG
    ]

    rows += ["", "## Нарушения по прогонам", ""]
    for result in bad:
        rows.append(f"- **{result.code} · {result.policy}**")
        for rule, at, detail in result.violations:
            rows.append(f"  - `{rule}` {int(at) // 60:02d}:{int(at) % 60:02d} — {detail}")
    rows += ["", "## Расшифровки", ""]
    for result in results:
        if result.violations or everything:
            rows.append("```")
            rows.append(result.transcript or f"{result.code} · {result.policy}: прогон упал")
            rows.append("```")
            rows.append("")
    return "\n".join(rows)
