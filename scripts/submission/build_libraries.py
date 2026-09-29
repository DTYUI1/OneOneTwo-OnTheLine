"""Перечень библиотек для сдачи (ТЗ §13, §18): версии и лицензии из окружения и pnpm.

Запуск из корня: `uv run python scripts/submission/build_libraries.py`
(нужны `uv sync --all-packages --frozen` и `pnpm install --frozen-lockfile`).
Пишет docs/submission/documentation/05_libraries.md.
"""

import importlib.metadata as metadata
import json
import subprocess
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "docs/submission/documentation/05_libraries.md"
OWN = {"arm112-api", "evalcore", "arm112-scripts", "oneonetwo-workspace"}
DEV = {
    "pytest",
    "pytest-cov",
    "coverage",
    "ruff",
    "mypy",
    "mypy-extensions",
    "pluggy",
    "iniconfig",
    "pygments",
    "types-pyyaml",
    "types-jsonschema",
    "packaging",
    "pathspec",
    "openapi-spec-validator",
    "openapi-schema-validator",
    "jsonschema-path",
    "lazy-object-proxy",
    "rfc3339-validator",
    "pathable",
}


# Модели, данные и образы: не Python/JS-пакеты, но входят в поставку.
ASSETS = [
    (
        "Qwen3-4B-Instruct-2507, GGUF Q4_K_M",
        "unsloth/Qwen3-4B-Instruct-2507-GGUF",
        "Apache-2.0",
        "файлом `models/…gguf`, не в Git; `deploy/offline.py`",
    ),
    (
        "llama.cpp server",
        "ghcr.io/ggml-org/llama.cpp:server@sha256:9dc0a0f4…",
        "MIT",
        "образ `arm112-llm:0.1.0`",
    ),
    ("PostgreSQL", "16.10 (образ Compose)", "PostgreSQL License", "Docker-образ"),
    ("nginx", "образ Compose web", "BSD-2-Clause", "Docker-образ"),
    (
        "Piper TTS, голоса denis/dmitri/irina/ruslan",
        "PR #16 (B-01)",
        "CC0 / CC0 / не указана / CC BY-NC-SA 4.0",
        "решение капитана по irina/ruslan открыто",
    ),
    (
        "Классификатор 046_24, билеты, памятка ДДС",
        "материалы кейсодержателя",
        "права не установлены",
        "`docs/dataset/`, только для хакатона",
    ),
]


def python_rows() -> list[tuple[str, str, str, str]]:
    rows = []
    for dist in metadata.distributions():
        meta = dist.metadata
        name = meta["Name"]
        if name.lower() in OWN:
            continue
        license_ = (meta.get("License-Expression") or "").strip()
        if not license_:
            raw = (meta.get("License") or "").strip()
            license_ = raw if raw and len(raw) < 60 else ""
        if not license_:
            classifiers = [
                c.split("::")[-1].strip()
                for c in meta.get_all("Classifier") or []
                if c.startswith("License ::")
            ]
            license_ = "; ".join(sorted(set(classifiers))) or "не указана в метаданных"
        role = "разработка и проверки" if name.lower() in DEV else "работа приложения"
        rows.append((name, dist.version, license_, role))
    return sorted(rows, key=lambda row: row[0].lower())


def pnpm(*args: str) -> dict[str, list[dict]]:
    output = subprocess.run(
        ["pnpm", "licenses", "list", "--json", *args],
        cwd=ROOT / "apps/web",
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return json.loads(output)


def main() -> None:
    python = python_rows()
    prod = pnpm("-P")
    everything = pnpm()
    package = json.loads((ROOT / "apps/web/package.json").read_text(encoding="utf-8"))
    licenses = {
        item["name"]: (license_, item["versions"][0])
        for license_, items in everything.items()
        for item in items
    }
    lines = [
        "# 5. Перечень библиотек",
        "",
        "Собран скриптом `scripts/submission/build_libraries.py` из фактически установленных",
        "зависимостей (`uv.lock`, `pnpm-lock.yaml`). Лицензии — из метаданных пакетов.",
        "Своих пакетов (`arm112-api`, `evalcore`, `arm112-scripts`) в таблицах нет.",
        "",
        "## 5.1 Python (API, worker, оценщик, скрипты)",
        "",
        "| Библиотека | Версия | Лицензия | Назначение |",
        "|---|---|---|---|",
    ]
    lines += [f"| {n} | {v} | {lic} | {role} |" for n, v, lic, role in python]
    lines += [
        "",
        "## 5.2 JavaScript — в сборке веб-приложения",
        "",
        "| Библиотека | Версия | Лицензия |",
        "|---|---|---|",
    ]
    prod_rows = sorted(
        (item["name"], item["versions"][0], license_)
        for license_, items in prod.items()
        for item in items
    )
    lines += [f"| {n} | {v} | {lic} |" for n, v, lic in prod_rows]
    lines += [
        "",
        "## 5.3 JavaScript — инструменты разработки (прямые зависимости)",
        "",
        "| Библиотека | Версия | Лицензия |",
        "|---|---|---|",
    ]
    for name in sorted(package.get("devDependencies", {})):
        license_, version = licenses.get(name, ("не определена", package["devDependencies"][name]))
        lines.append(f"| {name} | {version} | {license_} |")
    counts = Counter({license_: len(items) for license_, items in everything.items()})
    lines += [
        "",
        f"Всего JS-пакетов с транзитивными: {sum(counts.values())}; по лицензиям: "
        + ", ".join(f"{lic} — {n}" for lic, n in counts.most_common())
        + ".",
        "",
        "## 5.4 Модели, данные и образы",
        "",
        "| Компонент | Версия/источник | Лицензия | Как поставляется |",
        "|---|---|---|---|",
        *(f"| {' | '.join(row)} |" for row in ASSETS),
        "",
    ]
    OUTPUT.write_text("\n".join(lines), encoding="utf-8")
    print(
        f"Записано {OUTPUT.relative_to(ROOT)}: Python {len(python)}, JS в сборке {len(prod_rows)}"
    )


if __name__ == "__main__":
    main()
