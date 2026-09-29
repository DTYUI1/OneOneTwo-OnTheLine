# 5. Перечень библиотек

Собран скриптом `scripts/submission/build_libraries.py` из фактически установленных
зависимостей (`uv.lock`, `pnpm-lock.yaml`). Лицензии — из метаданных пакетов.
Своих пакетов (`arm112-api`, `evalcore`, `arm112-scripts`) в таблицах нет.

## 5.1 Python (API, worker, оценщик, скрипты)

| Библиотека | Версия | Лицензия | Назначение |
|---|---|---|---|
| alembic | 1.16.5 | MIT | работа приложения |
| annotated-types | 0.8.0 | MIT | работа приложения |
| anyio | 4.15.1 | MIT | работа приложения |
| argon2-cffi | 25.1.0 | MIT | работа приложения |
| argon2-cffi-bindings | 26.1.0 | MIT | работа приложения |
| asyncpg | 0.30.0 | Apache License, Version 2.0 | работа приложения |
| attrs | 26.1.0 | MIT | работа приложения |
| certifi | 2026.7.22 | MPL-2.0 | работа приложения |
| cffi | 2.1.1 | MIT-0 | работа приложения |
| charset-normalizer | 3.5.1 | MIT | работа приложения |
| click | 8.5.0 | BSD-3-Clause | работа приложения |
| coverage | 7.16.1 | Apache-2.0 | разработка и проверки |
| cryptography | 46.0.1 | Apache-2.0 OR BSD-3-Clause | работа приложения |
| DAWG2-Python | 0.9.0 | MIT | работа приложения |
| fastapi | 0.116.1 | MIT License | работа приложения |
| greenlet | 3.5.6 | MIT AND PSF-2.0 | работа приложения |
| h11 | 0.16.0 | MIT | работа приложения |
| httpcore | 1.0.9 | BSD-3-Clause | работа приложения |
| httptools | 0.8.0 | MIT | работа приложения |
| httpx | 0.28.1 | BSD-3-Clause | работа приложения |
| idna | 3.20 | BSD-3-Clause | работа приложения |
| iniconfig | 2.3.0 | MIT | разработка и проверки |
| jsonschema | 4.25.1 | MIT | работа приложения |
| jsonschema-path | 0.3.4 | Apache-2.0 | разработка и проверки |
| jsonschema-specifications | 2025.9.1 | MIT | работа приложения |
| lazy-object-proxy | 1.12.0 | BSD-2-Clause | разработка и проверки |
| Mako | 1.4.1 | MIT | работа приложения |
| MarkupSafe | 3.0.3 | BSD-3-Clause | работа приложения |
| mypy | 1.18.1 | MIT | разработка и проверки |
| mypy_extensions | 1.1.0 | MIT | работа приложения |
| openapi-schema-validator | 0.6.3 | BSD-3-Clause | разработка и проверки |
| openapi-spec-validator | 0.7.2 | Apache-2.0 | разработка и проверки |
| packaging | 26.3 | Apache-2.0 OR BSD-2-Clause | разработка и проверки |
| pathable | 0.4.4 | Apache-2.0 | разработка и проверки |
| pathspec | 1.1.1 | Mozilla Public License 2.0 (MPL 2.0) | разработка и проверки |
| pluggy | 1.6.0 | MIT | разработка и проверки |
| pycparser | 3.0 | BSD-3-Clause | работа приложения |
| pydantic | 2.13.5 | MIT | работа приложения |
| pydantic-settings | 2.10.1 | MIT | работа приложения |
| pydantic_core | 2.46.5 | MIT | работа приложения |
| Pygments | 2.21.0 | BSD-2-Clause | разработка и проверки |
| PyJWT | 2.10.1 | MIT | работа приложения |
| pymorphy3 | 2.0.6 | MIT license | работа приложения |
| pymorphy3-dicts-ru | 2.4.417150.4580142 | MIT license | работа приложения |
| pytest | 8.4.2 | MIT | разработка и проверки |
| pytest-cov | 6.3.0 | MIT | разработка и проверки |
| python-dotenv | 1.2.3 | BSD-3-Clause | работа приложения |
| python-multipart | 0.0.20 | Apache-2.0 | работа приложения |
| PyYAML | 6.0.2 | MIT | работа приложения |
| referencing | 0.36.2 | MIT | работа приложения |
| requests | 2.34.2 | Apache-2.0 | работа приложения |
| rfc3339-validator | 0.1.4 | MIT license | разработка и проверки |
| rpds-py | 2026.6.3 | MIT | работа приложения |
| ruff | 0.13.0 | MIT License | разработка и проверки |
| setuptools | 84.0.0 | MIT | работа приложения |
| six | 1.17.0 | MIT | работа приложения |
| SQLAlchemy | 2.0.43 | MIT | работа приложения |
| starlette | 0.47.3 | BSD-3-Clause | работа приложения |
| types-jsonschema | 4.25.1.20250822 | Apache-2.0 | разработка и проверки |
| types-PyYAML | 6.0.12.20250915 | Apache-2.0 | разработка и проверки |
| typing-inspection | 0.4.4 | MIT | работа приложения |
| typing_extensions | 4.16.0 | PSF-2.0 | работа приложения |
| urllib3 | 2.8.0 | MIT | работа приложения |
| uvicorn | 0.35.0 | BSD-3-Clause | работа приложения |
| uvloop | 0.22.1 | MIT License | работа приложения |
| watchfiles | 1.2.0 | MIT | работа приложения |
| websockets | 17.1 | BSD-3-Clause | работа приложения |

## 5.2 JavaScript — в сборке веб-приложения

| Библиотека | Версия | Лицензия |
|---|---|---|
| @remix-run/router | 1.23.0 | MIT |
| @tanstack/query-core | 5.87.1 | MIT |
| @tanstack/react-query | 5.87.1 | MIT |
| ajv | 8.17.1 | MIT |
| ajv-formats | 3.0.1 | MIT |
| fast-deep-equal | 3.1.3 | MIT |
| fast-uri | 3.1.8 | BSD-3-Clause |
| idb | 8.0.3 | ISC |
| js-tokens | 4.0.0 | MIT |
| json-schema-traverse | 1.0.0 | MIT |
| loose-envify | 1.4.0 | MIT |
| openapi-fetch | 0.14.0 | MIT |
| openapi-typescript-helpers | 0.0.15 | MIT |
| react | 18.3.1 | MIT |
| react-dom | 18.3.1 | MIT |
| react-router | 6.30.1 | MIT |
| react-router-dom | 6.30.1 | MIT |
| require-from-string | 2.0.2 | MIT |
| scheduler | 0.23.2 | MIT |

## 5.3 JavaScript — инструменты разработки (прямые зависимости)

| Библиотека | Версия | Лицензия |
|---|---|---|
| @eslint/js | 9.35.0 | MIT |
| @types/node | 22.18.1 | MIT |
| @types/react | 18.3.24 | MIT |
| @types/react-dom | 18.3.7 | MIT |
| @vitejs/plugin-react | 4.7.0 | MIT |
| eslint | 9.35.0 | MIT |
| fake-indexeddb | 6.1.0 | Apache-2.0 |
| openapi-typescript | 7.9.1 | MIT |
| prettier | 3.6.2 | MIT |
| typescript | 5.8.3 | Apache-2.0 |
| typescript-eslint | 8.42.0 | MIT |
| vite | 6.3.6 | MIT |
| vitest | 3.2.4 | MIT |

Всего JS-пакетов с транзитивными: 385; по лицензиям: MIT — 310, Apache-2.0 — 36, ISC — 22, BSD-2-Clause — 8, BSD-3-Clause — 4, Python-2.0 — 1, CC-BY-4.0 — 1, CC0-1.0 — 1, 0BSD — 1, (MIT OR CC0-1.0) — 1.

## 5.4 Модели, данные и образы

| Компонент | Версия/источник | Лицензия | Как поставляется |
|---|---|---|---|
| Qwen3-4B-Instruct-2507, GGUF Q4_K_M | unsloth/Qwen3-4B-Instruct-2507-GGUF | Apache-2.0 | файлом `models/…gguf`, не в Git; `deploy/offline.py` |
| llama.cpp server | ghcr.io/ggml-org/llama.cpp:server@sha256:9dc0a0f4… | MIT | образ `arm112-llm:0.1.0` |
| Морфологический словарь русского языка (проверка грамотности и ключевых слов, 28.09) | OpenCorpora через `pymorphy3-dicts-ru` 2.4.417150 | пакет — MIT, данные OpenCorpora — CC BY-SA | в образе API (пакет Python), без сети; словарь 112 — `apps/api/app/core/spelling_112.txt` |
| PostgreSQL | 16.10 (образ Compose) | PostgreSQL License | Docker-образ |
| nginx | образ Compose web | BSD-2-Clause | Docker-образ |
| Piper TTS, голоса denis/dmitri/irina/ruslan | PR #16 (B-01) | CC0 / CC0 / не указана / CC BY-NC-SA 4.0 | решение капитана по irina/ruslan открыто |
| Классификатор 046_24, билеты, памятка ДДС | материалы кейсодержателя | права не установлены | `docs/dataset/`, только для хакатона |
