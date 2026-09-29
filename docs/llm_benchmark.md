# T-037 — выбор локальной LLM для генерации сценариев

Статус: CPU-протокол Luna выполнен 2026-09-21; выбранный Qwen подключён к production worker
через llama.cpp и включается явно с `AI_PROVIDER=local` + Compose profile `llm`.
Испытания проведены в отдельном контейнере llama.cpp на Intel i7-11800H (8C/16T), 16 GB RAM;
GPU RTX 3050 Laptop 4 GB в этот результат не включён.

## Воспроизводимость

| Поле | Значение |
|---|---|
| Docker image | `ghcr.io/ggml-org/llama.cpp:server` |
| Docker digest | `sha256:9dc0a0f4080b7817c9592b19c03a4f4b0be92fd701076b9da259ff941dc5bf91` |
| threads / context / max tokens | 8 / 4096 / 300 |
| quantization | Q4_K_M |
| prompt/schema | `apps/api/app/worker/prompts/scenario_narrative_system.md`, `contracts/scenario-narrative.schema.json` |
| temperature / seed | 0.2 / фиксированный seed по кейсу и повтору |
| model artifacts | Hugging Face cache в Docker volume `arm112-llama-cache`; SHA-256 GGUF не зафиксирован в этом прогоне |

Протокол: `docs/LLM_TESTING_LUNA.md`. JSONL содержит сырой ответ, метрики и параметры запуска.
Автоматический gate проверяет HTTP, JSON, JSON Schema и покрытие входных фактов; ручной veto
обязателен для любой опасной галлюцинации.

## Быстрый CPU-отсев

| Модель | JSON/Schema | Факты mean/min | p50/p95, s* | tok/s p50 | Ручная оценка | Итог |
|---|---:|---:|---:|---:|---|---|
| Qwen3-4B-Instruct-2507 Q4_K_M | 100/100% | 100/100% | 31.490/55.919 | 13.172 | лучшее заземление; в case-5 добавлено отопление | финалист |
| Phi-4-mini-instruct Q4_K_M | 100/100% | 66.7/33.3% | 18.678/34.467 | 14.036 | выдуманные действия/даты, искажённый класс | veto |
| Gemma-3-4B-it Q4_K_M | 100/100% | 73.3/33.3% | 32.875/59.897 | 13.634 | выдуманные службы/скорую/соседа, смена класса | veto |

\* Screen latency записана до исправления таймера и включает ожидание semaphore; для сравнения
latency использованы только финальные прогоны ниже. JSONL screen:

- Qwen: `tmp/llm-benchmark/20260921T123830Z-qwen3-4b-2507-q4km-cpu-screen-v2-c1.jsonl`
- Phi: `tmp/llm-benchmark/20260921T131543Z-phi4-mini-q4km-cpu-screen-c1.jsonl`
- Gemma: `tmp/llm-benchmark/20260921T133811Z-gemma3-4b-it-q4km-cpu-screen-c1.jsonl`

## Полный прогон финалистов

| Модель / режим | Запросы | Schema | Факты mean/min | p50/p95, s | tok/s p50 | Gate | Решение |
|---|---:|---:|---:|---:|---:|---|---|
| Qwen3-4B, 1 slot / c=1 | 30 | 100% | 100/100% | 12.154/13.816 | 12.349 | PASS | default-кандидат |
| T-lite-it-2.1 8B, 1 slot / c=1 | 30 | 93.3% | 95.3/66.7% | 13.573/14.855 | 7.322 | FAIL | quality ceiling, не default |

JSONL и отчёты:

- Qwen c=1: `tmp/llm-benchmark/20260921T141623Z-qwen3-4b-2507-q4km-cpu-final-v2-c1.jsonl` и `.md`
- T-lite 8B: `tmp/llm-benchmark/20260921T144028Z-t-lite-it-2.1-q4km-cpu-ceiling-c1.jsonl` и `.md`

T-lite провалил gate из-за короткого description/schema в повторных ответах case-6,
а также потерял факты в case-7 и case-10; ручные ответы содержат непредусмотренные
призывы к срочному действию. Это полезная граница качества, но не безопасный production default.

## Concurrency 1 против 2 (Qwen3-4B)

| Режим | Запросы | Общее время, s | p95 запроса, s | tok/s p50 | Решение |
|---|---:|---:|---:|---:|---|
| 1 slot / c=1 | 30 | ~383 (14:10:00–14:16:23 UTC) | 13.816 | 12.349 | baseline/default |
| 2 slots / c=2 | 20 | ~189 (14:18:59–14:22:08 UTC) | 18.607 | 9.262 | только для throughput |

JSONL c=2: `tmp/llm-benchmark/20260921T142208Z-qwen3-4b-2507-q4km-cpu-concurrency2-c2.jsonl`.

Два слота уменьшают время серии, но повышают p95 и снижают скорость одного запроса из-за
конкуренции за 8 CPU-потоков. Для интерактивной генерации оставить один слот; c=2 включать
только после отдельного нагрузочного подтверждения без swap/pagefile.

## Рекомендация

- **default:** `qwen3-4b-2507-q4km` (Qwen3-4B-Instruct-2507 Q4_K_M), CPU, 8 threads, 1 slot.
- **fallback:** детерминированный шаблон из входных фактов при timeout, ошибке schema/validator
  или ручном veto; LLM не принимает RBAC, маршрутизацию, приоритеты и решения о вызове служб.
- **quality ceiling:** `t-lite-it-2.1-q4km`; не использовать в production без дополнительного
  prompt/validator-прогона и повторной оценки.
- **concurrency:** production default `1`; `2` — опциональный throughput-режим.
- **CUDA:** не требовалась для принятого CPU-решения; RTX 3050 можно исследовать отдельно.

Production provider повторяет параметры принятого прогона: alias `qwen3-4b-2507-q4km`,
8 CPU threads, context 4096, max tokens 300, temperature 0.2, один slot. Перед возвратом
результата он проверяет JSON Schema, наличие типа происшествия/улицы/дома и запрещает новые
числовые детали; любой отказ переводит генерацию на template fallback. Runtime image закреплён
digest в `deploy/docker-compose.yml`, GGUF хранится вне git в Docker volume/offline bundle.

Даже принятый Qwen иногда добавлял нейтральные, но не заданные фразы (например, отопление в
case-5). Поэтому перед сохранением карточки нужен строгий validator и fallback, а не слепое
доверие среднему автоматическому баллу.

Выходной контракт зафиксирован в `contracts/scenario-narrative.schema.json`: LLM генерирует
только `caller_name`, `description`, `tags`; бизнес-факты и маршрутизация остаются в коде.
