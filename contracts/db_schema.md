# Схема БД T-007

## C-01: план расширения хранения, не готовая миграция

C-01 **не меняет** ORM/SQL и не добавляет Alembic revision. Новые JSON-формы описаны
в c01.schema.json и алиасах `storage.C01*`, но действующий worker их не пишет.
Миграции и проверка upgrade существующей БД обязательны для следующих владельцев:

| Задача | Будущее хранение и ограничения |
|---|---|
| C-02 | nullable sessions.timing_policy JSONB по TimingPolicy; отсутствие = legacy. Clock samples/pong привязаны к actor/sample_id, immutable; nullable card_events.clock_sample_id FK, сырые timestamps/старый offset не меняются |
| C-03 | assignment_batches с UNIQUE(teacher_id,session_id,request_id), canonical request/receipt; assignments: nullable delay_from_start_s/scenario_version/batch_id, режим доставки, due_at от started_at. Старый planned_at сохраняется; существующий CHECK статусов расширяется cancelled для v2 |
| C-03 | card_attempts или nullable interruption metadata отдельно от Card.state; finish+отмена выдачи в одной транзакции с общим порядком блокировок. Старые completed не переинтерпретировать |
| C-04 | brigades(service_id FK), call_targets(service_id,brigade_id nullable); calls.target_id/brigade_id nullable, end_reason nullable; справочники не означают диспетчеризацию транспорта |
| C-04 | versioned scenario training plan, immutable message deliveries UNIQUE(card_id,message_id,version), append-only presentation attempts по actor/client_event_id; защита playback/version; audio manifests с hash, внутренние пути вне HTTP |
| C-05 | versioned ScenarioContent sidecar с общей Scenario.version, provenance, training plan; content request receipts scoped actor/operation/request_id; revision jobs хранят expected_version |
| C-06 | отдельные versioned timing/analysis JSONB по TimingResult/EvaluationAnalysis; requirements/layers/model versions; прогноз immutable, nullable факты дописываются один раз, overrides отдельным журналом |
| C-07 | immutable materials(id,version,owner,purpose,hash,internal_path), session_materials с точной версией и audit; новые материалы не переписывают историю оценки |

Транзакционные request receipts хранятся весь срок жизни объекта. Нельзя переиспользовать
один request_id для другого тела или владельца. При backfill nullable-связи старых calls/
assignments остаются null, старые сценарии без плана и старые оценки по-прежнему читаются.
Никаких UPDATE/DELETE card_events/audit/teacher_overrides/predictions исходных полей.
Для v2 задания без подтверждённого предъявления сведения не считаются доступными.
Новая схема применяется только после совместного обновления API/worker; миграция должна
сохранять существующие записи и проверяться на копии/выделенной БД, без удаления volumes.

## Действующая схема

Источник: `architecture/system_design.md` §3. PostgreSQL 16, SQLAlchemy async,
Alembic `0001` — `apps/api/migrations/versions/0001_initial.py`;
модели — `apps/api/app/core/models.py`. D1/mock не создаёт таблицы автоматически.

| Таблица | Ключ / связи / существенные ограничения |
|---|---|
| users | UUID PK, login UNIQUE, password_hash, role enum, full_name, is_active, created_at |
| auth_sessions | UUID PK (`sid` JWT), user_id FK, csrf_hash, expires_at, created_at; logout удаляет строку |
| services | text PK (`101`,`102`,`103`,`104`,`GKH`,`MOSLIFT`), code UNIQUE, phone_ext UNIQUE 3 цифры, voice_profile, category, is_active |
| incident_types | text code PK (ведущие нули сохраняются), group_no/name, sign1..3, scenario_code, main_service_code, raw |
| routing_rules | incident_type_code FK, service_id FK, condition JSONB (`data_formats.md`), payload |
| streets | id, name, name_norm, okrug, district, source |
| scenarios | UUID PK, version, level CHECK 1..4, weight CHECK 1..10, target_service_id FK, card/reference/complications по scenario.schema.json, origin, status, author_id, teacher_comment |
| scenario_packs / scenario_pack_items | pack_id FK, scenario_id FK, order; status draft/approved/retired |
| sessions | UUID PK, teacher_id FK users, title, status draft/running/finished, timestamps, settings_snapshot, timing_policy (jsonb по TimingPolicy; NULL — legacy v1) |
| workstations | integer PK, number UNIQUE CHECK 1..23 |
| session_participants | UUID PK, session_id/user_id/workstation_id/dds_service_id FK, level, rating_at_start; UNIQUE(session_id,user_id), UNIQUE(session_id,workstation_id) |
| assignments | UUID PK, session_id, participant_id, scenario_id, order, planned_at, status |
| cards | UUID PK, assignment_id FK, number, state enum, appeared_at/delivered_at/opened_at/first_status_at/closed_at, current по current.schema.json, redirected_to_service_id FK |
| card_events | UUID PK, card_id/actor_id FK, client_event_id, client_ts/server_ts, clock_offset_ms, type, payload; UNIQUE(actor_id,client_event_id); append-only |
| calls | UUID PK, card_id FK, dialed_ext, service_id FK, started_at/answered_at/ended_at, audio_path, transcript |
| predictions | UUID PK, card_id/participant_id FK, made_at, p_success/expected_score/p_timeout 0..1, expected_time_s, theta_before, b_scenario, model_version, actual_score/time_s/timeout nullable |
| evaluations | UUID PK, card_id FK, version, rules/semantic/llm_scores, total 0..1, critical_flags, explanation, model_info, status, created_at |
| teacher_overrides | UUID PK, evaluation_id/teacher_id FK, agree/disagree, new_total, criterion_patches, reason, teacher_comment, created_at; append-only |
| trainee_ratings | user_id PK/FK, theta, theta_var, history |
| settings | key PK, value JSONB, updated_by FK, updated_at |
| audit_log | UUID PK, ts, actor_id, action, entity, entity_id, before/after, ip; append-only |
| jobs | UUID PK, kind, payload, status, attempts, locked_by, locked_at, idempotency_key UNIQUE nullable, run_after, result, error |
| worker_heartbeats | worker_id text PK, updated_at; состояние worker для health |
| seed_artifacts | path PK (относительно data/), schema_name, content JSONB; исходные classifier/templates/golden/packs/voice manifest |

**Дополнения T-007 (`contract:`):** у `users` сохраняются nullable
`workstation_number` (FK workstations.number) и `dds_service_id` (FK services.id),
которые уже присутствуют в HTTP User. Назначение внутри занятия по-прежнему хранится
в `session_participants`. `auth_sessions` отделена от учебных `sessions`:
JWT содержит sid/sub/exp/iat/iss/aud, права читаются из актуальной users.
CSRF хранится как SHA-256; пароль — Argon2id. Пароли, JWT и CSRF не попадают в аудит.

`settings` хранит документ Settings целиком под ключом `training`, поэтому смена нормативов
и весов атомарна. `seed_artifacts` сохраняет исходные данные для воспроизводимости и
манифест голосов; это не новая публичная HTTP-операция.

JSONB: card/reference/complications → scenario.schema.json; current → current.schema.json;
card_events.payload → соответствующая ветвь card-event.schema.json; settings и
settings_snapshot → OpenAPI Settings; classifier raw/condition и seed assets →
storage.schema.json; scores/criterion_patches → storage.Scores, critical_flags →
storage.CriticalFlags, explanation → storage.Explanations, model_info → storage.ModelInfo,
ratings.history → storage.RatingHistory; audit before/after → storage.AuditSnapshot.
Jobs payload/result описаны в jobs.md и storage.JobPayload/JobResult.

С 23.09.2026 `storage.Explanations` допускает для каждого ключа критерия старую
строку либо объект `{"explanation": "текст", "evidence": ["основание"]}`.
API и worker записывают объект, сериализатор читает обе формы. Для старой строки
HTTP/WS возвращают `evidence: []`: потерянные основания не восстанавливаются.
Миграция SQL и пересчёт старых оценок не нужны: используется существующий JSONB.
При развёртывании обновляйте API и worker вместе, до возобновления обработки оценок:
старый API не понимает объект, а старый worker при пересчёте теряет `evidence`.
Публичные формы HTTP/WS и интерфейс evalcore не изменены.

`cards.current` и `card_events` изменяются в одной транзакции. `server_ts` ставит сервер;
`delivered_at` — подтверждение отображения карточки, а не время HTTP-ответа.
Предсказание неизменно; после завершения один раз дописываются nullable-поля факта.
UPDATE/DELETE/TRUNCATE журналов запрещены триггерами PostgreSQL. В predictions каждое
поле факта можно заполнить из NULL один раз; исходные поля запрещено менять.
Все времена TIMESTAMPTZ UTC. Индексы: events(card_id,server_ts), cards(assignment_id),
jobs(status,run_after), predictions(participant_id,made_at), audit_log(ts).

[ASSUMPTION D1] `Assignment.participant_id` в HTTP сейчас содержит user UUID внутри занятия
(составной ключ session_id/user_id); адаптер T-008 разрешает его в внутренний UUID
session_participants. Это исключает требование фронтенду создавать DB-идентификаторы.
Пример связи: `data/templates/traffic.json` → assignment из OpenAPI → Card из OpenAPI.
