# Очередь api → worker

## Дополнение C-01 (план C-05, пока не исполняется)

Существующие generate/evaluate и их payload/result сохранены. Новые options на
`POST /packs/generate` и revise отвечают 501 до C-05; успешный фиктивный Job не создаётся.
Будущий `kind=generate` переиспользуется с `contract_version=2`, discriminator
`operation=generate|revise`: `storage.C01GenerateJobPayload` и `C01ContentJobResult`.
При generate pack_id обязателен, scenario_id/expected_version=null, input=GenerateInput;
при revise наоборот, input=ScenarioRevisionInput. Не передавать v2 старому worker:
включение только после совместного обновления API/worker, неизвестная версия →failed.
Ключ enqueue `(kind, actor_id, request_id)` и атомарное создание job/receipt;
для обеих операций kind=generate, actor_id берётся из авторизованного пользователя.
В generate `payload.request_id = input.options.request_id`, в revise
`payload.request_id = input.request_id`; API/worker проверяют равенство, второй
ключ не создаётся. Generate v2 требует непустой объект options; legacy/null туда
не переводятся. Полный исходный HTTP-ввод сохраняется в input.

Единые [правила HTTP-повтора](C01_INTERFACES.md#i-content--c-05c-07-d-01d-03):
receipt сравнивает operation, scenario_id из URL revise и canonical JSON всего тела.
Порядок ключей объектов незначим, порядок массивов значим. Тот же ключ/содержимое
возвращают HTTP 202 с тем же Job.id и актуальным status/error; другой ввод, операция
или сценарий с тем же ключом →409. Созданный сервером pack_id не является частью
клиентского запроса и повторно не генерируется. Повтор не перезапускает done/failed.
Receipt хранится весь срок хранения Job; конкурентный enqueue создаёт одну задачу.
Текущие права проверяются до чтения receipt, распознанный повтор revise не проверяется
как новая правка старой версии. Worker retry использует сохранённый payload/ключ.
Legacy generate без options сохраняет прежний payload и не обещает идемпотентность HTTP.
Перед записью revise worker повторно проверяет version и отсутствие assignment,
при конфликте не перезаписывает контент и завершает failed с объяснением.
Публичный старый Job не расширен эталоном; `GET /jobs/{id}/progress` для учителя-владельца
возвращает JobProgress: completed/total и ID сценариев/пакета, warnings, без reference.
`completed≤total`, done требует completed=total; failed может иметь частичный прогресс,
но ещё не approved контент. Ответы pending/running без фиктивного 100%.

## Действующий D1

Только PostgreSQL `jobs`; worker не имеет HTTP API (ADR-11).
Публичный конверт: `{id: UUID, kind, payload, status, attempts, locked_by, run_after, result, error}`.
Внутри БД worker также использует `locked_at` (начало аренды) и nullable
`idempotency_key = kind:entity_id:version`; эти поля браузеру не выдаются.
Статусы: pending → running → done/failed. `error` nullable, русское описание без ПДн.

| kind | payload | result |
|---|---|---|
| generate | `{pack_id, count, level, service_id, seed}` | `{scenario_ids: UUID[]}` |
| evaluate | `{card_id, evaluation_id}` | `{evaluation_id, version}` |
| insights | `{session_id}` | `{weakest_criteria: string[], explanation: string}` |
| transcribe | `{call_id}` | `{call_id, transcript, provider}` |
| tts | `{voice_profile, phrase_id}` | `{relative_path, duration_ms}` |

Пример: `{kind: 'evaluate', payload: {card_id: '…', evaluation_id: '…'}, status: 'pending'}`.
Внешний Job в OpenAPI — публичное состояние задачи, без payload/результата с эталоном.
В T-010: получение `FOR UPDATE SKIP LOCKED`, bounded retries, тайм-аут аренды, идемпотентность
по `(kind, entity_id, version)`, восстановление зависших running. Список путей к аудио не
принимается от браузера: worker извлекает путь по call_id из БД.
Планировщик выдачи карточек живёт только в worker; прогноз пишется ДО выдачи карточки.
Один assignment создаёт не более одной карточки, один card — не более одного прогноза.
До T-026 `generate` использует явно помеченную копию утверждённого шаблона; при наличии
`evalcore.scenario.build` worker вызывает его через отдельный адаптер. Отключённые STT,
embeddings и LLM возвращают контрактные частичные результаты, но не имитируют работу модели.
