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
С 16.10 `generate` использует `evalcore.scenario.build(constructor, classifier=...)`,
классификатор 046_24 и ограниченные учебные сюжеты `data/scenario-generation-scenes.json`.
Для нового сценария сохраняются карточка, эталон, версионный TrainingPlan и
`scenario-generation-metadata.schema.json`. Технические ссылки присоединяет код,
доклады без соответствующей озвучки идут текстом. После двух неудачных ответов
включается проверенный шаблонный путь с origin=template, независимо от AI_PROVIDER.
Обычный пакет студии остаётся draft. Внутренний флаг `auto_admit=true` допускает только
новые проверенные сценарии подготовки занятия; публичный GenerateInput его не принимает.
Идентификатор сценария стабилен относительно (pack_id, order); повтор handler
продолжает отсутствующее. Результат дополнен `fallback_count` и `complete`.
Порция generate — один недостающий сценарий в отдельной транзакции. После commit
ScenarioPackItem, Job.result и ai_preparation.completed видны другим соединениям;
незавершённый job возвращается в pending, run_after — часы БД в конце порции,
attempts обнуляется после успешной порции. Сбои одной порции ограничены обычным
worker_max_attempts; пакет из 92/100 карточек не исчерпывает попытки самим прогрессом.
Повтор/рестарт продолжает отсутствующие порядки с теми же UUID5, готовое не переделывает.
Первая карточка не означает готовность пакета: auto-approved пакет и назначения
создаются только после проверки всего набора. Частичный pack остаётся draft.
Готовые задания остальных типов, включая оценку и транскрипцию, обрабатываются
перед следующей порцией генерации с сохранением их прежнего порядка. Все local generate/evaluate получают общий PostgreSQL advisory
EXECUTION_LOCK на время handler. Второй worker возвращает job без ошибки и расхода
attempts, если слот занят. Перед новой генерацией проверяется и оценка, уже полученная
другим worker: генерация уступает ей. SCHEDULING_LOCK остаётся коротким и независимым;
heartbeat, карточки и доклады не ждут модель. Ожидание после занятия проверяется заново
при каждом claim и непосредственно перед выполнением каждой порции.
Возврат просроченных задач пропускает блокировки живых handler даже при исчерпании
attempts, не задерживая другую очередь. Уже начатый HTTP-запрос к llama.cpp не прерывается;
порция включает не более двух запросов генератора (до 180 с каждый), затем проверенный
fallback. Оценка получает приоритет после commit порции, мгновенный ответ не обещается.
Отключённые STT,
embeddings и LLM возвращают контрактные частичные результаты, но не имитируют работу модели.

Локальный общий ИИ: `generation_policy=after_lessons` (также при отсутствии поля)
ожидает завершения всех `kind=lesson,status=running` всех преподавателей. Практика
не считается конфликтом. `now` — явный выбор преподавателя после предупреждения;
автоподготовка сама его не выбирает. Ожидание не меняет attempts и не является ошибкой.
Короткий PostgreSQL advisory lock согласует старт занятия, claim и повторную проверку
перед выполнением. Во время запроса модели этот lock планирования не удерживается.
Отложенный pending не мешает начать другое занятие, которое продлит ожидание.
Публичный `JobProgress.generation_state`: waiting / queued / generating / ready / failed.
GET /packs/generation-jobs восстанавливает последние собственные задания после reload;
GET /ai/resource выдаёт только три обезличенных boolean. При AI_PROVIDER=off конфликта нет.
`GenerateInput.generation_request_id` обеспечивает один пакет для повторов одного тела
по (actor_id, generatePack, UUID). Это отдельное совместимое расширение, а spec-first
`options` по-прежнему отклоняется через 501, корневой `request_id` не принимается.
POST /sessions/{id}/start без mode при занятой генерации возвращает 409 ai_generation_busy;
mode=now явно разрешает запуск, wait сохраняет запрос в БД, cancel отменяет ожидание.
Ожидание относится ко всему набору jobs, занявших ресурс при выборе, включая промежутки
между их порциями. Worker запускает готовое занятие после освобождения ресурса, с аудитом
startSession; закрытая вкладка и перезапуск API/worker не теряют запрос. Готовое
ожидание старта проверяется также под той же блокировкой перед следующим claim;
следующий pending generate не отодвигает занятие. При активной генерации другие worker
могут получать оценку, но не получают другую pending генерацию заранее; просроченная
running генерация по-прежнему восстанавливается по аренде.

ИИ-занятие использует `storage.AIPreparationJobPayload`: тот же generate с session_id,
auto_admit=true и конечным списком items (до 92). Для каждого item независимо
сохраняются participant_id (публичный user UUID), service_id, level, weight, seed и order.
Настройки задания выбираются до постановки по текущей оценённой истории участника.
Сценарии получают стабильный UUID от pack_id/порядка в общем списке; назначения —
отдельный порядок для каждого участника. После готовности всего списка создаётся
AssignmentBatch с request_id=uuid5(session_id, "ai-assignments"). Подготовка — draft,
не running; нормативы не начинаются на генерации. GET Session выводит серверное
состояние Job, а при failed показывает явную ошибку.
