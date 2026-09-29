# Скрипты данных — капитан

Для C-01: `sync_c01_contracts.py` переносит `$defs` из c01.schema.json в OpenAPI draft;
`--check` запрещает drift. Затем штатные export_openapi/gen:api. validate_contracts
также проверяет examples/c01.json и timing-v2.json. check_prism ожидает 501 для pending
операций (статическая проверка Error, не доказательство работающего backend).

`uv sync --all-packages` из корня, затем `uv run --package arm112-scripts python scripts/<script>.py`.
`build_classifier.py` пишет только `data/classifier.json`, без БД; результат воспроизводим.
`validate_contracts.py` читает и валидирует OpenAPI/JSON/фикстуры, без сетевых запросов.
`build_fixtures.py` пересобирает 10 golden для 6 служб/4 уровней из кодов классификатора.
`check_prism.py` проверяет GET-ответы запущенного Prism против OpenAPI (localhost:4010).
`pytest scripts/tests` проверяет контракты и воспроизводимость артефакта классификатора.
Идемпотентная загрузка этих файлов в БД принадлежит `app.seed`, T-007.

`llm/start_llama_server.ps1` запускает официальный Docker-образ `llama.cpp` с указанным GGUF
репозиторием; `llm/run_benchmark.ps1` прогоняет одинаковые golden-кейсы и сохраняет JSONL/Markdown
в игнорируемый `tmp/llm-benchmark/`. Полный протокол выбора модели — `docs/LLM_TESTING_LUNA.md`.
