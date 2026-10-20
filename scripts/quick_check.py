"""Быстрые проверки перед коммитом: только то, что задевает diff (HQ-054).

    uv run python scripts/quick_check.py            # изменения рабочей копии против HEAD
    uv run python scripts/quick_check.py --base origin/feature/dds-gameplay   # ещё и коммиты
    uv run python scripts/quick_check.py --dry-run  # только показать, что запустится

Что выбирается по изменённым файлам:

- Python (`apps/api`, `packages/evalcore`, `scripts`): ruff check и ruff format --check по
  изменённым файлам, mypy целиком (инкрементальный, кеш `.mypy_cache`).
- pytest: тестовые файлы, которые прямо или через цепочку импортов зависят от изменённого
  модуля. Граф импортов строится по исходникам (ast), без запуска кода. Файл данных
  (`data/…`) считается изменением модулей, в тексте которых упомянута его папка, — так
  `data/scenarios/x.json` выбирает тесты загрузчика и линтера сценариев. Изменённый
  `conftest.py` выбирает все тесты своей папки.
- Контракты (`contracts/`): validate_contracts.py, sync_c01_contracts.py --check.
- Движок мира (тренировка, worker, evalcore, окно телефона) или сценарии: прогон связности
  (`python -m app.tools.coherence`). По изменённым сценариям — `--only` с ними; движок — все
  сценарии одной политикой «эталон»; все ветки и политики — `--full` (или ночью).
- Веб (`apps/web/src`): eslint и prettier --check по файлам, tsc --noEmit, `vitest related`.
- e2e: печатает спеки `qa/e2e`, где упомянуты изменённые компоненты, — их гонять на стенде.

Нужен PostgreSQL для интеграционных тестов и прогона связности: `DATABASE_URL_TEST`
(как у pytest); без неё эти шаги пропускаются с предупреждением.
Код выхода 0 — всё выбранное зелёное, 1 — что-то упало.
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import shutil
import subprocess
import sys
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Корни пакетов: путь от корня репо → префикс имени модуля.
PACKAGE_ROOTS = {
    "apps/api/app": "app",
    "packages/evalcore/evalcore": "evalcore",
}
TEST_DIRS = ("apps/api/tests", "packages/evalcore/tests", "scripts/tests")
PY_DIRS = ("apps/api", "packages/evalcore", "scripts")
# Тест, который импортирует изменённый модуль сам (1) или через один модуль (2).
IMPORT_DEPTH = 2
# Правка здесь задевает все тесты: схема БД, зависимости, настройки pytest и mypy.
EVERYTHING = ("apps/api/migrations/",)
EVERYTHING_FILES = ("pyproject.toml", "uv.lock", "apps/api/alembic.ini", "apps/api/pyproject.toml")

# Где рождается поведение мира тренажёра: правка здесь требует прогона связности
# (docs/coherence_night.md, «Если ночь нашла нарушения»).
ENGINE_PREFIXES = (
    "apps/api/app/api/training/",
    "apps/api/app/worker/",
    "apps/api/app/tools/coherence/",
    "apps/api/app/seed/scenario_lint.py",
    "apps/api/app/seed/world_lexicon.py",
    "packages/evalcore/evalcore/",
    "apps/web/src/arm/softphone/",
)
SCENARIOS_PREFIX = "data/scenarios/"
WEB_SRC = "apps/web/src/"
WEB_CODE = (".ts", ".tsx")
WEB_PRETTIER = (".ts", ".tsx", ".css", ".json")
# Карта «файл → тесты, которые его исполняют» по покрытию полного прогона (`--all-tests`):
# роутер и сервис вызываются тестами по HTTP, импорта в тесте нет — граф импортов их не видит.
TEST_MAP = ROOT / "tmp" / "quick_check" / "test_map.json"
COVERAGE_FILE = ROOT / "tmp" / "quick_check" / ".coverage"
COVERED = ("apps/api/app", "packages/evalcore/evalcore", "scripts")


@dataclass
class Step:
    """Одна проверка: название, команда, папка запуска."""

    title: str
    command: list[str]
    cwd: Path = ROOT
    env: dict[str, str] = field(default_factory=dict)


def git_lines(*args: str) -> list[str]:
    # quotepath=off: кириллица в имени файла приходит как есть, а не в кавычках с кодами.
    result = subprocess.run(
        ["git", "-c", "core.quotepath=off", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
        encoding="utf-8",
    )
    return [line for line in result.stdout.splitlines() if line.strip()]


def changed_files(base: str) -> list[str]:
    """Изменённые, новые и удалённые файлы против `base` (с незакоммиченными). Удалённый
    модуль тоже выбирает тесты: его импортёры упадут на импорте."""
    names = set(git_lines("diff", "--name-only", base))
    names |= set(git_lines("ls-files", "--others", "--exclude-standard"))
    return sorted(names)


def existing(paths: list[str]) -> list[str]:
    return [path for path in paths if (ROOT / path).exists()]


# --- граф импортов Python ---------------------------------------------------------------


def module_name(path: str) -> str | None:
    """`apps/api/app/api/training/turns.py` → `app.api.training.turns`. Тесты — по пути
    (`apps.api.tests.test_x`): так разрешаются их относительные импорты помощников."""
    if not path.endswith(".py"):
        return None
    for root, prefix in PACKAGE_ROOTS.items():
        if path.startswith(root + "/"):
            parts = [prefix, *Path(path[len(root) + 1 :]).with_suffix("").parts]
            break
    else:
        if not path.startswith(tuple(f"{folder}/" for folder in TEST_DIRS)):
            return None
        parts = list(Path(path).with_suffix("").parts)
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


def python_sources() -> list[str]:
    files: list[str] = []
    for root in (*PACKAGE_ROOTS, *TEST_DIRS):
        files += [
            path.relative_to(ROOT).as_posix()
            for path in (ROOT / root).rglob("*.py")
            if "__pycache__" not in path.parts
        ]
    return sorted(files)


def imported_modules(path: str, own: str | None) -> set[str]:
    """Имена модулей, которые импортирует файл (и `from x import y` как `x.y`)."""
    try:
        tree = ast.parse((ROOT / path).read_text(encoding="utf-8"))
    except SyntaxError:
        return set()
    package = own.rsplit(".", 1)[0] if own else ""
    if own and path.endswith("__init__.py"):
        package = own
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names |= {alias.name for alias in node.names}
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            if node.level:
                anchor = package.split(".")
                anchor = anchor[: len(anchor) - (node.level - 1)] if node.level > 1 else anchor
                base = ".".join([*anchor, base] if base else anchor)
            names.add(base)
            names |= {f"{base}.{alias.name}" for alias in node.names}
    return names


def string_literals(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8", errors="replace")


def affected_tests(changed: list[str]) -> list[str]:
    """Тестовые файлы, которые импортируют изменённый модуль сами или через один модуль.

    Глубже не идём: фабрика приложения импортирует все роуты, и полное замыкание выбирало бы
    весь набор при любой правке. Всё целиком гоняется один раз перед review (`--all-tests`).
    """
    sources = python_sources()
    modules = {path: module_name(path) for path in sources}
    by_module = {name: path for path, name in modules.items() if name}
    importers: dict[str, set[str]] = {path: set() for path in sources}
    for path in sources:
        for name in imported_modules(path, modules[path]):
            # `from app.x import y` даёт `app.x` и `app.x.y`: модулем будет одно из них.
            target = by_module.get(name)
            if target and target != path:
                importers[target].add(path)

    # Удалённый модуль — по имени: его в исходниках уже нет, импортёры остались.
    gone = {module_name(path) for path in changed if not (ROOT / path).exists()} - {None}
    seeds = {path for path in changed if path in importers}
    seeds |= {path for path in sources if gone & imported_modules(path, modules[path])}
    selected: set[str] = set()
    data_dirs = data_directories(changed)
    # Файлы данных и скрипты (`scripts/x.py` тесты грузят по пути) — по имени файла в тексте
    # теста; без расширения — только код вида `lift-stuck-101-1`: «settings» встречается везде.
    stems = {
        Path(path).name
        for path in changed
        if path.startswith("data/") or (path.startswith("scripts/") and module_name(path) is None)
    }
    stems |= {Path(path).stem for path in changed if path.startswith("data/") and "-" in path}
    for path in sources:
        text = string_literals(path)
        if data_dirs and any(needle in text for needle in data_dirs):
            seeds.add(path)
        # Тест, где назван изменённый файл данных (код сценария), — тоже про него.
        if is_test(path) and stems and any(stem in text for stem in stems):
            selected.add(path)
    for path in changed:
        if path.endswith("conftest.py"):
            folder = path.rsplit("/", 1)[0] + "/"
            selected |= {item for item in sources if item.startswith(folder) and is_test(item)}
        if path.startswith(EVERYTHING) or path in EVERYTHING_FILES:
            # Схема БД, зависимости, конфиг pytest — задевают все тесты.
            selected |= {item for item in sources if is_test(item)}
        if path.startswith("contracts/"):
            selected |= {item for item in sources if is_test(item) and "contract" in item}

    frontier = set(seeds)
    reached = set(seeds)
    for _ in range(IMPORT_DEPTH):
        frontier = {imp for path in frontier for imp in importers.get(path, ())} - reached
        reached |= frontier
    selected |= {path for path in reached if is_test(path)}
    return sorted(selected)


def is_test(path: str) -> bool:
    return path.startswith(TEST_DIRS) and Path(path).name.startswith("test_")


def mapped_tests(changed: list[str]) -> list[str]:
    """Тесты из карты покрытия, исполнявшие изменённые файлы; карты нет — ничего."""
    if not TEST_MAP.exists():
        if any(module_name(path) for path in changed):
            print("! Карты тестов нет: выбор только по импортам. Соберите: --all-tests")
        return []
    files: dict[str, list[str]] = json.loads(TEST_MAP.read_text(encoding="utf-8"))["files"]
    return sorted(
        {test for path in changed for test in files.get(path, ()) if (ROOT / test).exists()}
    )


def build_test_map() -> int:
    """Карта из данных покрытия полного прогона: файл → тестовые файлы (контекст `test`)."""
    import coverage

    data = coverage.CoverageData(str(COVERAGE_FILE))
    data.read()
    files: dict[str, set[str]] = {}
    for measured in data.measured_files():
        path = Path(measured).resolve()
        if not path.is_relative_to(ROOT):
            continue
        tests = {
            context.split("::", 1)[0]
            for contexts in (data.contexts_by_lineno(measured) or {}).values()
            for context in contexts
            if "::" in context
        }
        if tests:
            files[path.relative_to(ROOT).as_posix()] = tests
    TEST_MAP.write_text(
        json.dumps(
            {"files": {path: sorted(tests) for path, tests in sorted(files.items())}},
            ensure_ascii=False,
            indent=0,
        ),
        encoding="utf-8",
    )
    print(f"Карта тестов: {len(files)} файлов → {TEST_MAP.relative_to(ROOT)}")
    return 0


def all_tests_step() -> Step:
    """Весь pytest с покрытием по контекстам тестов: заодно собирает карту для выбора."""
    COVERAGE_FILE.parent.mkdir(parents=True, exist_ok=True)
    covered = [f"--cov={path}" for path in COVERED]
    return Step(
        "pytest целиком (и карта тестов)",
        ["uv", "run", "pytest", "-q", "-n", "auto", *covered, "--cov-context=test"]
        + ["--cov-report="],
        env={"COVERAGE_FILE": str(COVERAGE_FILE)},
    )


def data_directories(changed: Iterable[str]) -> set[str]:
    """`data/scenarios/x.json` → строки, которыми код называет эту папку."""
    found: set[str] = set()
    for path in changed:
        parts = path.split("/")
        if parts[0] == "data" and len(parts) > 2:
            found.add(f'"data" / "{parts[1]}"')
            found.add(f'"data/{parts[1]}"')
    return found


# --- выбор проверок ---------------------------------------------------------------------


def python_steps(changed: list[str]) -> list[Step]:
    steps: list[Step] = []
    py = existing([path for path in changed if path.endswith(".py") and path.startswith(PY_DIRS)])
    if py:
        steps.append(Step("ruff check", ["uv", "run", "ruff", "check", *py]))
        steps.append(Step("ruff format --check", ["uv", "run", "ruff", "format", "--check", *py]))
        steps.append(Step("mypy", ["uv", "run", "mypy"]))
    tests = set(affected_tests(changed)) | set(mapped_tests(changed))
    tests |= unguarded(changed, tests)
    if tests:
        needs_db = any(path.startswith("apps/api/tests/") for path in tests)
        # pytest берёт БД только из DATABASE_URL_TEST, COHERENCE_DATABASE_URL ему не годится.
        if needs_db and not os.environ.get("DATABASE_URL_TEST"):
            print("! DATABASE_URL_TEST не задан: интеграционные тесты API будут пропущены")
        workers = "auto" if len(tests) > 1 else "0"
        steps.append(
            Step(
                f"pytest ({len(tests)} файлов)",
                ["uv", "run", "pytest", "-q", "-n", workers, *sorted(tests)],
            )
        )
    return steps


def unguarded(changed: list[str], selected: set[str]) -> set[str]:
    """Изменённый модуль, которого не коснулся ни один выбранный тест (ни импортом, ни по
    карте), — тогда все тесты его пакета: молча «зелёное» без проверки хуже лишней минуты."""
    folders = {
        "apps/api/": "apps/api/tests/",
        "packages/evalcore/": "packages/evalcore/tests/",
    }
    covered = {path for path in changed if module_name(path) is None or is_test(path)}
    if TEST_MAP.exists():
        mapped = json.loads(TEST_MAP.read_text(encoding="utf-8"))["files"]
        covered |= {path for path in changed if set(mapped.get(path, ())) & selected}
    found: set[str] = set()
    for path in changed:
        if path in covered or not path.endswith(".py"):
            continue
        hit = affected_tests([path]) or mapped_tests([path])
        if hit:
            continue
        for prefix, tests in folders.items():
            if path.startswith(prefix):
                print(f"! {path}: тестов по импортам и карте нет — все тесты {tests}")
                found |= {
                    item.relative_to(ROOT).as_posix() for item in (ROOT / tests).glob("test_*.py")
                }
    return found


def contract_steps(changed: list[str]) -> list[Step]:
    if not any(path.startswith("contracts/") for path in changed):
        return []
    return [
        Step("контракты", ["uv", "run", "python", "scripts/validate_contracts.py"]),
        Step(
            "контракты C-01 без расхождений",
            ["uv", "run", "python", "scripts/sync_c01_contracts.py", "--check"],
        ),
    ]


def coherence_steps(changed: list[str], database: str | None, full: bool) -> list[Step]:
    engine = any(path.startswith(ENGINE_PREFIXES) for path in changed)
    scenarios = sorted(
        Path(path).stem
        for path in changed
        if path.startswith(SCENARIOS_PREFIX) and path.endswith(".json")
    )
    if not (engine or scenarios or full):
        return []
    if not database:
        print("! DATABASE_URL_TEST не задан: прогон связности пропущен")
        return []
    api = ROOT / "apps/api"
    base = ["uv", "run", "python", "-m", "app.tools.coherence", "--database", database]
    out = ["--out", str(ROOT / "tmp/coherence/quick.md")]
    if full:
        return [Step("связность: все сценарии × ветки × политики", base + out, cwd=api)]
    steps: list[Step] = []
    if engine:
        # Движок задевает все сценарии; ветки и политики целиком — ночью или с --full.
        steps.append(
            Step("связность: эталон по всем сценариям", base + out + ["--policy", "эталон"], api)
        )
    if scenarios:
        steps.append(
            Step(
                f"связность: {', '.join(scenarios)} — все ветки и политики",
                base
                + ["--out", str(ROOT / "tmp/coherence/quick-scenarios.md"), "--only"]
                + scenarios,
                api,
            )
        )
    return steps


def web_steps(changed: list[str]) -> list[Step]:
    web_dir = ROOT / "apps/web"
    if (
        any(path.startswith("apps/web/") and not path.startswith(WEB_SRC) for path in changed)
        or "pnpm-lock.yaml" in changed
    ):
        # package.json, конфиги vite/eslint/tsconfig задевают весь веб-клиент.
        return [
            Step("pnpm lint", ["pnpm", "lint"], cwd=web_dir),
            Step("pnpm typecheck", ["pnpm", "typecheck"], cwd=web_dir),
            Step("pnpm test", ["pnpm", "test"], cwd=web_dir),
        ]
    web = existing([path for path in changed if path.startswith(WEB_SRC)])
    if not web:
        return []
    local = [path[len("apps/web/") :] for path in web]
    code = [path for path in local if path.endswith(WEB_CODE)]
    pretty = [path for path in local if path.endswith(WEB_PRETTIER)]
    steps: list[Step] = []
    if code:
        steps.append(Step("eslint", ["pnpm", "exec", "eslint", *code], cwd=web_dir))
    if pretty:
        steps.append(
            Step(
                "prettier --check",
                ["pnpm", "exec", "prettier", "--check", "--ignore-path", ".prettierignore"]
                + pretty,
                cwd=web_dir,
            )
        )
    steps.append(Step("tsc --noEmit", ["pnpm", "exec", "tsc", "--noEmit"], cwd=web_dir))
    if code:
        steps.append(
            Step(
                "vitest related",
                ["pnpm", "exec", "vitest", "related", "--run", "--passWithNoTests", *code],
                cwd=web_dir,
            )
        )
    return steps


def e2e_hint(changed: list[str]) -> list[str]:
    """Спеки e2e, в которых упомянут изменённый модуль веба (по имени файла)."""
    stems = {
        Path(path).stem
        for path in changed
        if path.startswith(WEB_SRC) and path.endswith(WEB_CODE) and ".test." not in path
    }
    specs = sorted((ROOT / "qa/e2e").glob("*.ts"))
    if not stems:
        return []
    found: list[str] = []
    for spec in specs:
        text = spec.read_text(encoding="utf-8", errors="replace")
        if any(re.search(rf"\b{re.escape(stem)}\b", text) for stem in stems):
            # Долгие тесты с тегом @night обычный прогон пропускает (qa/playwright.config.ts).
            found.append(spec.name + (" (@night — E2E_NIGHT=1)" if "@night" in text else ""))
    return found


def run(steps: list[Step]) -> int:
    failed: list[str] = []
    for step in steps:
        started = time.monotonic()
        print(f"\n== {step.title}", flush=True)
        # На Windows pnpm — это pnpm.cmd: без полного пути subprocess его не найдёт.
        command = [shutil.which(step.command[0]) or step.command[0], *step.command[1:]]
        result = subprocess.run(command, cwd=step.cwd, env={**os.environ, **step.env})
        spent = time.monotonic() - started
        mark = "ok" if result.returncode == 0 else "упало"
        print(f"-- {step.title}: {mark} за {spent:.0f} с", flush=True)
        if result.returncode:
            failed.append(step.title)
    if failed:
        print("\nУпало: " + "; ".join(failed))
        return 1
    print("\nВсё выбранное зелёное.")
    return 0


def main() -> int:
    # Вывод в канал на Windows идёт в cp1251: «×» и кириллица имён ломали бы печать.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Быстрые проверки по изменённым файлам")
    parser.add_argument("--base", default="HEAD", help="с чем сравнивать (по умолчанию HEAD)")
    parser.add_argument(
        "--full", action="store_true", help="прогон связности по всем веткам и политикам"
    )
    parser.add_argument("--no-coherence", action="store_true", help="без прогона связности")
    parser.add_argument("--dry-run", action="store_true", help="только показать проверки")
    parser.add_argument(
        "--all-tests",
        action="store_true",
        help="весь pytest (перед review) и карта тестов для следующих быстрых проверок",
    )
    args = parser.parse_args()

    if args.all_tests:
        code = run([all_tests_step()])
        # Карту строим и после упавших тестов: покрытие от этого не хуже.
        return build_test_map() or code

    changed = changed_files(args.base)
    if not changed:
        print("Изменений нет.")
        return 0
    database = os.environ.get("COHERENCE_DATABASE_URL") or os.environ.get("DATABASE_URL_TEST")
    steps = python_steps(changed) + contract_steps(changed) + web_steps(changed)
    if not args.no_coherence:
        steps += coherence_steps(changed, database, args.full)

    print(f"Изменено файлов: {len(changed)}. Проверки:")
    for step in steps:
        print(f"  - {step.title}")
    specs = e2e_hint(changed)
    if specs:
        print("e2e на стенде (не запускаются здесь): " + " ".join(specs))
    if args.dry_run:
        for step in steps:
            print("$ " + " ".join(step.command))
        return 0
    return run(steps)


if __name__ == "__main__":
    sys.exit(main())
