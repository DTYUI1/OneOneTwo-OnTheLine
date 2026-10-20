"""Прогон связности мира: `python -m app.tools.coherence` — все сценарии × ветки × политики;
одна команда и перед коммитом, и ночью.

Код выхода 1 — есть нарушения (или прогон упал), 0 — мир связен; нарушения правил, которые
ждут решения пользователя (`Invariant.pending`), в отчёте отдельно и код выхода не меняют.
Адрес PostgreSQL с правом CREATE DATABASE — `--database` или переменная
`COHERENCE_DATABASE_URL` (как `DATABASE_URL_TEST`); прогон создаёт засеянный шаблон и копии
для процессов и удаляет их в конце.
"""

import argparse
import os
import sys
import time
from pathlib import Path

from app.seed.scenarios import SCENARIOS_DIR
from app.tools.coherence.invariants import failing
from app.tools.coherence.night import report, run_all


def main() -> int:
    parser = argparse.ArgumentParser(description="Прогон связности мира тренажёра ДДС")
    parser.add_argument(
        "--database",
        default=os.environ.get("COHERENCE_DATABASE_URL") or os.environ.get("DATABASE_URL_TEST"),
    )
    parser.add_argument(
        "--scenarios",
        type=Path,
        default=SCENARIOS_DIR,
        help="папка сценариев (по умолчанию data/scenarios)",
    )
    parser.add_argument("--only", nargs="*", help="коды сценариев")
    parser.add_argument("--policy", nargs="*", help="политики: эталон, readback:met, readback …")
    parser.add_argument(
        "--jobs", type=int, default=os.cpu_count() or 8, help="процессов (у каждого своя БД)"
    )
    parser.add_argument("--out", type=Path, default=Path("tmp/coherence/report.md"))
    parser.add_argument("--all", action="store_true", help="расшифровки всех прогонов")
    args = parser.parse_args()
    if not args.database:
        parser.error("нужен --database или COHERENCE_DATABASE_URL (postgresql+asyncpg://…)")
    started = time.monotonic()
    results = run_all(
        args.database,
        args.scenarios,
        args.only,
        args.policy,
        args.jobs,
        progress=True,
    )
    text = report(results, everything=args.all)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(text, encoding="utf-8")
    bad = sum(1 for item in results if item.failed)
    violations = sum(1 for item in results for rule, _, _ in item.violations if failing(rule))
    print(
        f"Прогонов: {len(results)}, с нарушениями: {bad}, нарушений: {violations} "
        f"за {time.monotonic() - started:.0f} с. Отчёт: {args.out}"
    )
    return 1 if bad or not results else 0


if __name__ == "__main__":
    sys.exit(main())
