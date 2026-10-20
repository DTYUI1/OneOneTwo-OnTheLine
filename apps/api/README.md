# API и worker — капитан

`GET /practice/catalog` — общий каталог выбора для обучаемого и преподавателя:
одинаковые ID, версии, названия, описания и виды событий, без эталонов. Включает
сценарии с обязательным звонком заявителю, но не удалённые сценарии. Полный список
студии `GET /scenarios` остаётся отдельным; доступ администратора к учебному процессу
не расширяется. `POST /practice` по-прежнему доступен только обучаемому. Прямой запуск
удалённого сценария через `?scenario=…` возвращает `404 scenario_not_found` и не
заменяет текущую тренировку. Проверки: `tests/test_practice_catalog.py`.

19.10: `PATCH /sessions/{id}/norms` с `handling_normative_s` (целое 1…3600) — только
владелец-преподаватель черновика. Норматив одновременно обновляется в `settings_snapshot`
и `timing_policy` (legacy null сохраняется); запуск и правка используют блокировку занятия.
После старта — 409. Проверки без БД: `tests/test_session_norms.py`.

24.09, C-04: в `API_MODE=database` работают справочники бригад/телефонных адресатов,
ручной выбор `brigades_select`, `call_dial_target`, `GET /cards/{id}/training`
и защищённое аудио выданного сообщения. Worker выдаёт сообщения плана только
в отвеченном звонке нужному адресату с задержкой от answered_at. Выдача и скачивание
не подтверждают предъявление: для этого нужен `message_presented` после завершения
playback либо явного прочтения текста. `message_failed` сохраняется отдельно;
повтор playback не дублирует результат, поздний сбой не отменяет прежний успех.
`training.updated` содержит только card_id/revision; после reconnect перечитать training.
Текущая миграция — **0005**, API и worker обновляются вместе.
`python -m app.seed` добавляет синтетический справочник; `python -m app.seed.training`
создаёт отдельный повторяемый текстовый пример C-04 и выводит scenario_id.
Версии аудио хранятся в `INFORMATION_AUDIO_DIR`, SHA-256 проверяется при выдаче файла.
План/эталон хранится отдельно и не выдаётся обучаемому. Редактор ScenarioContent — C-05.
Интерфейсы для B-02/V-02, проверки и ограничения: отчёт C-03/C-04.

24.09, C-03: в `API_MODE=database` реализованы атомарный
`POST /sessions/{id}/assignments/batch`, чтение исходных `assignment-batches`,
`finish` с `{contract_version: 2, request_id}` и `GET /sessions/{id}/lifecycle`.
Перед запуском обновить БД: `python -m alembic -c apps/api/alembic.ini upgrade head`
(C-03 добавил **0004**, текущая head — **0005**); API и worker обновляются вместе.
Пачка проверяется целиком; исходный 201 сохраняется и повторяется после start/finish.
Новый request_id нужен для новой пачки; иной порядок items с прежним ключом даёт 409.
Scheduler считает delay от started_at, сохраняет прогноз до появления карточки,
использует общий с finish и card events порядок блокировок Session → Assignment → Card.
Finish отменяет будущую выдачу, фиксирует interruption отдельно от Card.state,
закрывает calls с end_reason=session_finished; запись можно загрузить после остановки.
Lifecycle ограничивает данные обучаемого его собственными попытками.

Для D-01: legacy GET assignments возвращает назначения с абсолютным planned_at;
новые назначения читать из assignment-batches (неизменяемые receipts), отмену/попытки —
из lifecycle. До старта due_at=null в receipt; фактическое время вычисляется при старте
и хранится в assignments.due_at. Для B-02: обрабатывать session.finished/call.state,
повторять прежний client_event_id; новое событие после finish получает
`409 session_finished`, уже принятое — исходный receipt с duplicate=true.
TimingPolicy пока null (C-02); mock по-прежнему отвечает 501 на операции C-03.
Подробности хранения, проверки и команда запуска: отчёт C-03.

24.09, интеграция C-01: закрытие WS отменяет его текущие send/receive перед close,
запрещает новые heartbeat и ограничивает I/O пятью секундами. Зависший клиент
не задерживает доставку остальным; reconnect повторяет авторизацию и snapshot.
Регрессия на настоящем ASGI WebSocket: `tests/test_realtime_transport.py`;
права и отзыв сессии с PostgreSQL: `tests/test_realtime_database.py`.

C-01: контракты/передача. Добавлены spec-first
операции C-02…C-07 с проверкой JSON/RBAC/CSRF и честным 501 в database и mock.
Необязательные timing_policy/options/finish body и новые card events также явно
отклоняются до реализации; старые запросы сохранены. ORM/миграции не менялись.
`app/api/c01.py` — проверки общей границы, новые типы — `contracts/c01.schema.json`.
Проверка: `python -m pytest apps/api/tests/test_c01_contracts.py -q` с DATABASE_URL_TEST.

23.09, исправления после интеграции: API проверяет веса всех семи критериев той же
функцией, что evalcore; пустой/нулевой набор, неполный набор и неконечная сумма дают 422.
Нулевой отдельный вес и дополнительные неотрицательные ключи совместимы с прежним API.
Черновой эталон без решения можно сохранить, но нельзя утвердить, назначить или запустить
с ним занятие. Проверка также выполняется перед стартом для ранее сохранённых назначений.
Worker сохраняет `partial`, пока выполнен только rules-слой, независимо от narrative-провайдера.

Проверка старых данных без записи (использует `DATABASE_URL`):
`python -m app.tools.audit_evaluation_inputs`. Выводит JSON с ID проблемных настроек,
занятий и утверждённых эталонов; код 0 — ошибок нет, 1 — нужны исправления. Команда не
меняет историю и использует read-only транзакцию. Исправлять назначенные сценарии нужно копией.

## Постоянный API — T-007/T-008

**28.09.** `app/api/problem_reports/`: `POST /problem-reports` (любая роль, CSRF) сохраняет
сообщение об ошибке — тему, текст и экран; роль и автор берутся из сессии. `GET
/problem-reports` — только администратор, 200 свежих сверху. В аудит пишется факт и тема,
текст — нет (может содержать ПДн). Миграция `0014`. Там же 28.09: `0013` — `calls.refusal`,
звонок ненаправленной бригаде принимается и записывает отказ (`app/api/training/events.py`).

`API_MODE=database`: PostgreSQL, Alembic 0001–0003, Argon2id, JWT-cookie, CSRF, RBAC,
auth/login/me/logout, GET users, GET/PUT settings, health/admin/health, транзакционный аудит.
В первом фрагменте T-008 добавлены GET `/services`, `/incident-types`, `/packs` из БД
(`app/api/catalog/`). Службы и типы отсортированы по строковому code (ведущие нули сохранены),
пакеты — по id, scenario_ids внутри пакета — по scenario_pack_items.order.
Выдаются все службы (включая неактивные) и все статусы пакетов: контракт не задаёт фильтров.
Пакеты доступны преподавателю/администратору; исходные эталоны и внутренние поля не выдаются.
Второй фрагмент T-008 — GET `/scenarios`, GET `/scenarios/{id}`, POST `/scenarios` (201)
и PUT `/scenarios/{id}` (`app/api/scenarios/`), только teacher/admin; мутации требуют CSRF.
Список содержит все статусы, сортируется по id. Тело POST/PUT — полный Scenario;
ID и начальная version задаются клиентом, вложенные поля проверяются по JSON Schema.
PUT принимает текущую version и увеличивает её на 1. Устаревшая версия или любое
назначение сценария участнику дают 409: для изменения назначенного эталона создаётся копия
с новым ID. Это сохраняет исходные данные и эталон прошлых занятий.
Снимки до/после сохраняются в audit_log вместе с мутацией. Правило PUT — явное
[ASSUMPTION] для ревью капитана; контракт и проверки — `docs/T008_SCENARIOS.md`.
Финальный фрагмент T-008 добавляет jobs генерации пакетов, sessions/participants/assignments,
start/finish, cards/events, calls/upload и рабочий `/ws` через PostgreSQL LISTEN/NOTIFY.
Детали, границы и проверки — `docs/T008_LIFECYCLE.md`.
T-010 добавляет worker без HTTP: очередь PostgreSQL с `SKIP LOCKED`, аренда/recovery,
bounded retries и идемпотентный enqueue; планировщик создаёт Card и Prediction одной
транзакцией до `NOTIFY`. Health сообщает `worker=ok` только при свежем heartbeat.
`database=ok` означает доступность актуальной миграции и начальных настроек.
T-009 добавляет мгновенную rules-оценку при закрытии карточки, фоновый job `evaluate`,
приватные GET оценок, append-only override преподавателя с аудитом и отчёты занятия JSON/CSV.
Пока внешний `evalcore` T-006 не реализован, partial-оценка явно помечается
`rules=unavailable:T-006`, а prediction fact остаётся NULL — отсутствие результата не считается
нулевым баллом.

### Локальная Qwen в production worker

Выбранный по `docs/llm_benchmark.md` профиль подключён через OpenAI-compatible llama.cpp:
`Qwen3-4B-Instruct-2507 Q4_K_M`, alias `qwen3-4b-2507-q4km`, CPU, 8 потоков, один slot.
Модель генерирует только `caller_name`, `description`, `tags`; JSON Schema, обязательные факты
и новые числовые детали проверяются перед сохранением. HTTP/JSON/schema/fact error даёт
детерминированный template fallback и не меняет маршрутизацию или эталон.

Для включения задайте `AI_PROVIDER=local` в `.env` и запустите профиль:

```sh
docker compose --profile llm up -d llm worker
```

Первый online-старт скачивает GGUF в volume `llm-data`; для закрытого контура volume нужно
заполнить при сборке офлайн-бандла. Модель не входит в git и API/worker image. По умолчанию
`AI_PROVIDER=off`, поэтому обычный `docker compose up` не скачивает веса. Настройки endpoint,
alias, timeout, temperature и max tokens задаются `LLM_*` из `.env.example`.

### Запуск в Docker (PowerShell и Ubuntu)

Из корня скопируйте `.env.example` в `.env`, если файла ещё нет. Задайте
`API_MODE=database`, `JWT_SECRET` (постоянный случайный секрет не менее 32 байт) и
`DEMO_PASSWORD`. Секрет можно получить командой
`uv run python -c "import secrets; print(secrets.token_urlsafe(48))"` и сохранить только в `.env`.
Смена секрета инвалидирует существующие JWT. В Compose cookie Secure.

```sh
docker compose build api
docker compose up -d --wait db
docker compose up -d --wait migrate
docker compose run --rm --no-deps api python -m app.seed
docker compose up -d --wait
```

Compose запускает миграцию после готовности БД и до старта API и worker;
`create_all` при старте нет. Повторный seed вставляет
только отсутствующие записи, сохраняет пароли, настройки и отредактированные сценарии.
`DEMO_PASSWORD` применяется только при создании аккаунта. Манифест голосов загружается,
отсутствующий `streets.csv.gz` и pending-аудио отмечаются в JSON-логе (остатки T-005).
Неверные данные откатывают всю загрузку. Счётчики в логе — число входных записей,
а не новых вставок. Приоритет golden/template — `contracts/data_formats.md`.

### Локальный Python

Нужен доступный PostgreSQL и `DATABASE_URL=postgresql+asyncpg://...`. У Compose БД по
умолчанию не опубликована на хост: используйте Docker-команды выше либо отдельную локальную БД.
Для HTTP без TLS задайте `COOKIE_SECURE=false`.

```sh
uv sync --all-packages --frozen
uv run --package arm112-api alembic -c apps/api/alembic.ini upgrade head
uv run --package arm112-api python -m app.seed
uv run --package arm112-api python -m app.api
uv run --package arm112-api python -m app.worker
```

API слушает порт 8000. `SESSION_TTL_SECONDS=28800` по умолчанию.
JWT и CSRF сохраняются в cookie `session` (HttpOnly) и `csrf`, SameSite=Strict;
мутации после входа требуют `X-CSRF-Token`. Logout удаляет серверную auth_session.
Роль и активность читаются из БД на каждом запросе. Мутация и audit_log коммитятся вместе;
отказ записывается со статусом без тела запроса. Аудит не содержит паролей или токенов.

`app/api/{foundation,catalog,scenarios,packs,sessions,cards,evaluations}/` — рабочие HTTP-модули;
`app/api/realtime.py` — WS-хаб и listener; `core/` — БД,
модели, безопасность, аудит; `seed/` — загрузка; `migrations/` — Alembic и триггеры журналов.
Зависимости `argon2-cffi` (MIT) и `python-multipart` (Apache-2.0) нужны для Argon2id и upload;
версии закреплены в uv.lock. Аудио хранится в `AUDIO_DIR` (Compose volume `audio-data`).

### Проверки и контракт

```sh
uv run ruff check .
uv run ruff format --check .
uv run mypy
uv run --all-packages pytest -q
uv run --package arm112-api python -m app.tools.export_openapi --check
```

Для PostgreSQL-тестов задайте `DATABASE_URL_TEST` с правом CREATEDB. Отдельный сервер:

```sh
docker run -d --name arm112-api-test -p 127.0.0.1:15432:5432 -e POSTGRES_USER=arm112 -e POSTGRES_PASSWORD=api-test -e POSTGRES_DB=arm112_test postgres:16.10-alpine
docker exec arm112-api-test pg_isready -U arm112 -d arm112_test
```

Запускайте тесты после ответа `accepting connections`; первый старт PostgreSQL занимает несколько секунд.

PowerShell: `$env:DATABASE_URL_TEST='postgresql+asyncpg://arm112:api-test@127.0.0.1:15432/arm112_test'`.
Ubuntu: `export DATABASE_URL_TEST='postgresql+asyncpg://arm112:api-test@127.0.0.1:15432/arm112_test'`.
Тесты создают и удаляют только свою случайную БД `arm112_test_<uuid>`; исходная БД не очищается.
Без переменной PostgreSQL-тесты явно skipped; CI поднимает PostgreSQL и запускает их обязательно.

Экспорт строится из рабочих роутов/Pydantic/закреплённых JSON Schema для T-007…T-010;
операции T-009 сохраняют spec-first публичные формы. При изменении интерфейса обновляются draft,
экспорт и `pnpm gen:api`.
Тесты сравнивают schemas/paths, `--check` — весь экспорт. Дополнения — `contract:`,
архитектурное решение — ADR-17. Публичные формы данных сохранены; Health.mode расширен.

CRUD пользователей и чтение журнала аудита по HTTP пока
не имеют полного контракта D1 и будут отдельной задачей; новые endpoints здесь не добавлены.

## Грамотность и ключевые сведения комментария (28.09, без ИИ)

`app/core/spelling.py` — проверка русского текста: морфологический словарь OpenCorpora
(`pymorphy3`), словарь 112 (`app/core/spelling_112.txt`) и названия улиц (справочник +
адрес сценария). API (`evaluations/service.py`) и worker (`jobs/handlers.py`) передают её в
оценку (`EvalContext.text_checker`); критерии `spelling` и `comment_keywords` — в
`packages/evalcore/evalcore/comment.py`, методика — `docs/submission/documentation/02_methods.md`.

`POST /spelling/check` (`api/spelling/`) — подсказки в АРМ: обучаемому только по своей
карточке и при `settings_snapshot.spelling_hints`, иначе 409 `spelling_hints_off`; позиции
слов — в единицах UTF-16, как в JavaScript. Запрос ничего не меняет, поэтому в журнал аудита
не пишется (`core/audit.py`, `READ_ONLY_OPERATIONS`). `GET /settings` дополняет настройки,
сохранённые раньше, весами критериев комментария по умолчанию (`with_comment_defaults`).

## Живая бригада — события плана (DT-10, 08.10)

`app/api/training/scenario_events.py`: события `TrainingPlan.events` (уточнение, просьба о
другой службе, молчание, тревога; [контракт](../../contracts/scenario-events.md#accepted-1008)).
Worker перед выдачей записывает срабатывания (`fire_due_events`, таблица
`scenario_event_firings`, миграция 0016); `gating.report_schedule` добавляет реплики событий в
расписание и откладывает или подменяет доклады по исходу события (`evalcore.brigade`). Ответ
бригаде — событие карточки `brigade_reply`. Оценка — критерий `brigade_work`
(`EvalContext.scenario_events`). Вводная преподавателя (DT-06, #69) вызывает
`fire_event_now(db, card, event_id, injected_by=…, now=…)` под блокировкой карточки и затем
`app.worker.training.deliver_messages` / `ring_brigades` (или ждёт тик worker); неприменимое
событие — `EventNotApplicable` с причиной по-русски. События в сценариях — блок `live` в
`data/practice/*.json` и `data/link112/plots/*.json` (`app.seed.practice.live_events`).
Озвучка реплик и докладов тренировки — `data/voices/practice/manifest.json`
(`scripts/voices/practice_generate.sh`). Сценарии связки 112 → ДДС берут голос из банка
озвучки (наборы `data/voices/bank-v*`): запись фразы той же службы с точно тем же текстом
(книги службы и `scripts/voices/bank/link112/`, `app.seed.link112.bank_records`). Реплика без
записи уходит текстом.

`POST /calls/{id}/voice-report` (`api/voice_report/`, DT-05) — доклад службе голосом: одна
фраза (WAV/WebM/Ogg ≤ 10 МиБ) идущего звонка своей карточки распознаётся провайдером STT
(`STT_PROVIDER=local` — faster-whisper в сервисе `stt`). Общий STT-провайдер оставляет
только русский алфавит (включая ё), цифры и пунктуацию; нерусские вставки заменяются
пробелами без склеивания слов. Результат без букв и цифр считается пустым. Это очистка
распознанного текста, не перевод иностранной речи. В тексте ищутся части памятки ДДС,
с. 32 (DT-11, `evalcore.report.voice_report_parts`): `parts` — какие из `who` (кто вы),
`address` (адрес и повод), `card` (карточка), `change` (что изменилось) прозвучали; `choice` —
`full` или первая недостающая часть (`no_who`, `no_address`, `no_card`, `no_change`).
`choice: null` — не расслышано (пусто или уверенность ниже `STT_MIN_CONFIDENCE`). STT выключен —
503 `stt_off`. Аудио не хранится, в журнал аудита запрос не пишется; вид и части доклада клиент
передаёт в отбое звонка (`report_choices`, `report_parts`). Настройки занятия:
`voice_only` (варианты ответа не показываются) и `report_choice_factor` (доля балла доклада
вариантом, по умолчанию 0,5).

`POST /calls/{id}/voice-reply` (`api/voice_reply/`, DT-16) — ответ бригаде голосом: фраза и
`delivery_id` реплики бригады с вариантами ответа в идущем разговоре. Тот же STT, подсказки
распознаванию — подписи вариантов и улицы карточки и эталона (`evalcore.voice_reply.reply_hints`).
Ответ `{text, confidence, option_key, loudness}`: `option_key` — вариант по правилу
`evalcore.voice_reply.voice_reply_option`, `null` — не расслышано или не сопоставлено. Реплики нет у этой бригады на карточке — 404; звонок завершён, на реплику
не отвечают или уже ответили — 409. Непрослушанный вопрос можно повторно предъявить и
ответить на него в новом идущем звонке той же бригады, сохранив исходный `delivery_id`.
Ничего не сохраняет; вариант клиент отправляет событием `brigade_reply` с `mode: voice`.

## Совместимость и срок удержания (ревью DDS)

`TrainingScheduler` закрывает разговор после трёх минут непрерывного удержания по
серверному `server_ts` последнего `call_hold`; `call_resume` снимает срок, следующее
удержание начинает его заново. Обрабатываются и закрытые карточки. Нужен работающий
worker: вкладка, локальные часы и `sessionStorage` не участвуют. Клиент получает обычное
`call.state` со значением `ended`; повторный отбой возвращает `409 call_ended`. В БД причина
автоматического отбоя — `hold_timeout`; это внутренняя причина: в `callbacks.end_reason`
она остаётся `null`, как у завершённого разговора, без расширения контрактного enum.
Новый `call_hangup` живого звонка допускается после
закрытия карточки; новые исходящие звонки по закрытой карточке по-прежнему запрещены.

`call_hold` принимает необязательные `report_choices`, `report_modes`, `voice_failures`,
`report_parts`, `report_loudness`, `registration_number` — ровно поля и ограничения
`call_hangup`. Клиент передаёт накопленный снимок; журнал хранит его без изменения payload.
UUID в hold/resume сравниваются по значению, включая uppercase. При повторе того же
`client_event_id` запись не дублируется; новый hold удержанного звонка получает `hold_state`.
Оценщики API и worker используют последний явный снимок hold/hangup, в том числе части,
режимы, громкость, неудачи голоса и номер регистрации. Resume и отсутствие нового снимка
не стирают прежний; явный пустой список докладов означает, что доклада нет. Современные
hold/`hold_timeout` без снимка получают `reported=0`, а не legacy credit за само соединение.
Общий `call_context` передаёт внутренний `end_reason` оценщику, но не добавляет его в HTTP
модель звонка. Гонка expiry с hangup сериализована Session → Assignment → Card → Call:
первый успешный отбой остаётся окончательным, поздний получает `call_ended`.

Текущая head — **0026**: опубликованная 0025 русифицирует учебные имена,
а 0026 добавляет legacy-совместимость. При обновлении с 0017 или ниже миграция 0018 сохраняет реальные
моменты отправки по прежнему правилу в `legacy_brigade_dispatches`: первый отвеченный
звонок бригаде без отказа. Это не выдуманная вводная: текст и правильность адреса не
приписываются. Расписание докладов, события мира и распределение ролей бригад читают
общий `briefing.dispatched`; новые карточки по-прежнему требуют полную вводную.

Если исходная 0018 уже применена (в том числе на опубликованной 0025), в БД нет
надёжной границы смены правила. Для восстановления перед обновлением до 0026 администратор
передаёт **подтверждённый** момент развёртывания GP-05
(ISO-8601 с часовым поясом), а не текущую дату:

```sh
uv run --package arm112-api alembic -c apps/api/alembic.ini \
  -x brigade_briefing_cutover="$CONFIRMED_GP05_CUTOVER" upgrade head
```

Без параметра 0026 только создаёт таблицу совместимости и не угадывает старые отправки
по отсутствию вводной. Значение cutover для действующего стенда в репозитории неизвестно.
Восстановление следует выполнять до первого применения 0026: повтор `upgrade head` уже
выполненную миграцию не запускает. API и worker обновляются вместе после миграций.

## ИИ-оценка комментария (C-06)

ИИ-подбор в занятии (16.10, миграция 0019): преподаватель передаёт в SessionInput
`ai_selection: {request_id, cards_per_participant, generation_policy?}`
(1–4 карточки каждому, до 23 АРМ).
Одинаковый request_id и тело повторяют исходное занятие; другой ввод с тем же ключом — 409.
Нужен AI_PROVIDER=local; off/mock возвращают 503, обычные занятия работают по-прежнему.
По завершённым оценённым попыткам той же службы вызывается существующий recommend_level:
берутся последние пять карточек, последняя готовая rules-оценка и её переопределение,
исходный норматив и критические флаги. Незавершённые карточки и пустая новая переоценка
не считаются провалом. θ и ступени не подменяют уровень и не пересчитываются.
Весь пакет готовится в worker, затем существующий механизм AssignmentBatch создаёт
профильные назначения с закреплённой версией. До готовности всего набора start даёт 409;
started_at и due_at отсутствуют, нормативы начинаются по существующим правилам выдачи.
GET Session содержит ai_preparation с прогрессом и объяснениями выбора только учителю;
обучаемому это поле null. В обычных самостоятельных тренировках генератор не вызывается.
Публичный старый GenerateOptions остаётся spec-first (501); ИИ-подбор занятия не
выдаёт его за реализованную расширенную студию C-05.

16.10, полный генератор: адаптер использует существующий `evalcore.scenario.build`
с конструктором и классификатором 046_24. Поддержаны шесть служб, по три исходных
сюжета на службу; уровень 2 — отказ от работ (кроме 103), уровни 3–4 добавляют
существующие события уточнения и отсутствия связи. Ситуация, адрес, объём проверки
и набор действий меняются детерминированно, модель формирует содержание в этих границах.
Карточка/эталон/ScenarioTrainingPlan сохраняются вместе; проверяются схема, факты,
маршрутизация, бригада/адресат и достижимость. Новые доклады текстовые, без старой озвучки.
Обычная генерация студии создаёт draft; автодопуск применяется только при подготовке
ИИ-занятия. Неудачный ответ допускает не больше двух запросов, затем пригодный
origin=template с явным предупреждением. Происхождение и исходные ответы хранятся
в `scenarios.generation_metadata` (миграция 0018); ручные черновики не утверждаются.
API и worker обновляются вместе. Порция worker — один сценарий с отдельным commit;
частичный прогресс N/M виден другому соединению. После успешной порции job возвращается
в pending, а attempts сбрасывается: этот лимит ограничивает сбои порции, не длину пакета.
Рестарт продолжает недостающее с прежними UUID, готовое не генерируется заново.
Все local generate/evaluate используют общий PostgreSQL advisory lock, поэтому два
worker не занимают модель одновременно. Оценка, в том числе уже полученная другим
worker, имеет приоритет перед следующей порцией. Начатая порция не прерывается:
до двух запросов по 180 с, затем проверенный fallback; мгновенная оценка не обещается.

По умолчанию generation_policy=after_lessons ждёт завершения всех идущих занятий
преподавателей; самостоятельная practice не мешает. now — явный выбор после диалога,
автоподготовка его сама не выбирает. Предупреждение есть в студии и форме ИИ-занятия;
«После занятия» переживает reload и рестарт API/worker. Ожидание не расходует attempts.
У старта занятия при занятой генерации — «Начать сейчас», «Дождаться готовности»,
«Отмена»; ожидание хранится в sessions.start_request (0020), до старта часы не идут.
Сервер повторяет проверки старта и имеет действие отмены ожидания. Подробные формы
GET /ai/resource, GET /packs/generation-jobs, JobProgress.generation_state,
GenerateInput.generation_request_id и POST start с mode — в contracts/jobs.md.
При AI_PROVIDER=off предупреждений о конкуренции нет.

Генератор полного сценария имеет отдельные ограничения:
`GENERATION_TIMEOUT_SECONDS=180`, `GENERATION_MAX_TOKENS=1536`. Они не меняют
лимиты судьи (`JUDGE_TIMEOUT_SECONDS=120`, `LLM_MAX_TOKENS=300`), его промпт,
схему или модель. `LLM_TIMEOUT_SECONDS` сохранён для совместимости конфигурации.
Промпт нового формата — `app/worker/prompts/scenario_generation_system.md`,
схема — `contracts/scenario-generation.schema.json`: успешное содержание либо
диагностируемый отказ без пригодного к выдаче плана.

Независимый прогон промпта на локальной модели (этап A):
`uv run --package arm112-api python -m app.tools.scenario_generation_probe
--base-url http://127.0.0.1:47902/v1`. Исходные запросы, сырые ответы,
токены, длительности и результаты проверок сохраняются отдельной папкой
в `tmp/ai-scenario-generation/stage-a/`. Противоречивый пример намеренно
доходит до модели; отдельно проверяется серверный отказ. Прогон требует,
чтобы вход с резервом всего вывода помещался в контекст 4096.

Worker после rules-оценки вызывает судью (`app/worker/judging.py`, провайдер
`providers/judge/`). При `AI_PROVIDER=local` — llama.cpp с моделью `LLM_MODEL`
(по умолчанию Qwen3-4B-Instruct-2507 Q4_K_M), таймаут `JUDGE_TIMEOUT_SECONDS=120`;
иначе — `NullJudge`, слой llm не выполнен и оценка остаётся `partial`.

- Модели передаются ключевые факты (адрес, тип происшествия, решение, пострадавшие) и
  комментарий обучаемого как **данные** (поле JSON; инструкции внутри игнорируются).
  Эталонный текст модели не передаётся.
- Модель раскладывает факты на найденные/отсутствующие и оценивает понятность 0–1.
  Выдуманный или пропущенный факт, ответ вне схемы, таймаут — вердикта нет, итог по rules.
- Полнота = найденные / все факты (считает код). llm = (полнота + понятность) / 2.
- **Итог = 0,8 · rules_total + 0,2 · llm**; при критической ошибке `rules_total`
  уже умножен на `critical_cap`, а ИИ-доля также умножается на этот коэффициент.
  Поэтому итог не выше `critical_cap`, но разные объёмы ошибок не превращаются в
  одинаковые 50 %. Сохранённые ранее оценки не пересчитываются.
- Пустой комментарий оценивается правилом без модели (`rule:empty-comment`).
- Few-shot: до 3 последних решений преподавателя по этому же сценарию, созданных **до**
  текущей оценки; их ID — в `model_info.few_shot`. Старые оценки не переписываются.

## Mock для параллельной разработки

Из корня: `uv sync --all-packages`, затем `uv run --package arm112-api python -m app.api`.
API: `http://127.0.0.1:8000/api/health`; схема — `/api/openapi.json`.
Swagger/ReDoc с внешним CDN отключены для локального контура.
В dev без .env cookie доступны по HTTP. Если .env скопирован для Compose, задайте
`COOKIE_SECURE=false` для локального запуска без TLS.

`API_MODE=mock` по умолчанию: отдельный MockBackend использует контрактные примеры;
login/logout, RBAC, CSRF, приватность карточек, события, idempotency и WS работают в памяти.
Один процесс. Утрата состояния и сессий при рестарте ожидаема. Оценки/отчёты — примеры,
создание ресурсов возвращает примеры, бизнес-переходы ещё не валидируются. Upload — 501.
`API_MODE=skeleton` явно отвечает 501 на предметные методы; `/health` остаётся доступным.
Health сообщает `database=not_connected` и `worker=stub`: живой процесс не означает готовую БД.

`uv run --package arm112-api python -m app.worker` — второй entrypoint из того же пакета/образа.
Он не открывает порт: планирует карточки и обрабатывает jobs только через PostgreSQL.
`python -m app.seed` работает с PostgreSQL.
Тесты: `uv run --all-packages pytest apps/api/tests`.

Рабочие методы T-007 описаны выше; mock намеренно сохраняет поведение стартового каркаса.
