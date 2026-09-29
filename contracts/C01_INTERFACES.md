# Интерфейсы C-01 · 23.09.2026

OpenAPI 0.2.0 — совместимое дополнение D1 0.1.0, не версия нового готового MVP.
Машинный источник новых объектов — [c01.schema.json](c01.schema.json), `$defs`.
`python scripts/sync_c01_contracts.py` переносит их в draft; штатный API export и
генератор TS остаются как в ADR-17. [Примеры](examples/c01.json) — фикстуры,
не runtime-ответы и не материал для seed. Владелец общей схемы — капитан.

## Общие правила

В новых объектах все перечисленные поля обязательны, nullable указан явно.
Исключения: `SessionInput.timing_policy`, `GenerateInput.options`,
`CardEvent.clock_sample_id`, необязательное тело finish и `BatchValidationError.details.items`
(нет списка при общей ошибке JSON). Для `GenerateInput.options` явный null
тоже запрос нового режима и даёт 501. `SessionInput.timing_policy` реализован C-02
в database: без поля — v3, явный null — legacy v1 ([I-TIME](I-TIME.md)).
Старые запросы без расширений сохраняют поведение.
Все scores 0…1, уровни 1…4, веса 1…10; ID — стабильные UUID; timestamps UTC с Z.
Ссылки на службы остаются строками (например `102`), не UUID.

Новые операции помечены `x-implementation-status=contract-ready`, `x-owner=C-…`.
Сейчас database и mock проверяют авторизацию/CSRF, JSON-форму и формат UUID в пути,
затем отвечают **501** `{code:"http_501", message:"Контракт подготовлен; …", details:{}}`.
Для недоступного файла/объекта пока тоже 501: pending-обработчик не читает объект
и не раскрывает его существование. Полная предметная валидация и resource RBAC ниже —
обязательства владельца реализации, а не уже реализованное поведение заглушки.
Загрузка файлов до реализации отвечает 501 до чтения multipart; её лимиты не считаются
проверенными этим ответом. Новые JSON-параметры старых операций не игнорируются.

Ошибки при реализации: 401 вход; 403 роль/CSRF; 404 нет объекта **или доступа к нему**;
409 конфликт version/request_id/состояния; 422 форма/непригодный эталон/связи;
413 размер файла; 415 формат файла; 503 временная недоступность. Формат всегда Error.
422 пачки — тип BatchValidationError; после предметной проверки C-03:
`details.items=[{index,field,code,message}]`, никаких
чужих имён/эталонов. `index` — с нуля; код стабилен (`unknown_participant`,
`invalid_reference`, `service_mismatch`, `duplicate_order`, `unknown_scenario`).
Бизнес-конфликт не маскируется как успешный job/result.

RBAC новых учебных мутаций: только teacher; действий карточки/часов: только trainee.
Admin может читать новый технический каталог/состояние карточки, но не утверждать,
назначать, менять оценки/материалы. Старые D1 роли не расширялись и не ужесточались
этим PR: их пересмотр в C-07. `x-c01-extension-roles` уточняет роли новых опций
старых операций; проверка этого ограничения уже действует.
После реализации teacher видит только собственное занятие/контент/job, trainee —
свою карточку и назначенные материалы; admin не получает эталоны через новые ответы.

## I-TIME → V-01, C-02, B-03, D-03

Полный нормативный контракт, сигнатуры и 24 примера v2 — [I-TIME](I-TIME.md).
Дополнение 24.09 — [I-TIME v3](I-TIME.md#v3): направление `direct`, реакция до первичного
статуса, активная обработка, статусы `arrived`/`working`, 18 примеров `timing-v3.json`.
`SessionInput.timing_policy` → snapshot; `/sessions/{id}/lifecycle` → чтение snapshot;
`ClockSample` + `/clock/samples` и новый WS ping → проверенная поправка;
`AttemptAnalysis.timing` → UI/отчёты. C-01 не включает реализацию этих расчётов.

## I-SESSION → C-03, D-01, B-02

Уже работают: CRUD занятий, start/finish, одиночное назначение с абсолютным `planned_at`,
список назначений, scheduler. `participant_id` в HTTP — **user UUID внутри занятия**,
не внутренний ID session_participants. Старые planned_at остаются абсолютными.

| Операция | Вход → выход | Готовность |
|---|---|---|
| POST `/sessions/{id}/assignments/batch` | AssignmentBatchInput → AssignmentBatch, 201 | C-03, сейчас 501 |
| GET `/sessions/{id}/assignment-batches` | → AssignmentBatch[] | C-03, сейчас 501 |
| POST `/sessions/{id}/finish` с FinishInput | `{contract_version:2, request_id}` → прежний Session | C-03, сейчас 501; без тела работает legacy |
| GET `/sessions/{id}/lifecycle` | → SessionLifecycle | C-02/C-03, сейчас 501 |

**Выбранная гарантия пачки — всё или ничего в одной транзакции.** Никаких частичных
назначений и 207. UI отправляет одну пачку, не имитирует её серией старых POST.
Допустимо 1…230 элементов. Каждый элемент задаёт participant/scenario/version,
`order≥1`, `delay_from_start_s` 0…86400 и явный `delivery_mode`.
Обычный режим `profile`: target_service_id сценария должен совпасть с ДДС участника;
`intentional_mismatch` — осознанное упражнение неверной доставки, выбор учителя.
Каждый сценарий approved и пригоден по A2, версия совпадает; участник входит в занятие.

Пачка принимается только в draft. `(session_id, participant_id, order)` уникален
среди старых и новых назначений; позиции возрастают по участнику, без требования
непрерывной нумерации. delay по возрастающим order не убывает. При старте C-03
повторно валидирует все эталоны; `due_at=started_at+delay`, до старта `due_at=null`.
Просроченную выдачу scheduler выполняет в порядке `(due_at, order, id)` по участнику
с существующим ограничением parallel_cards. Разным участникам выдача независима.

Идемпотентность scoped `(teacher_id, session_id, request_id)`; canonical JSON тела
сохраняется вместе с назначениям. Тот же запрос возвращает **тот же сохранённый 201**,
даже после start/finish, если доступ ещё разрешён; порядок items значим.
Тот же ключ с другим телом →409; при потере ответа повторяют исходный запрос.
Ключи сохраняются на срок жизни занятия. Повтор не создаёт новые задания/прогнозы.
Чтение batches возвращает исходные receipts; актуальный статус остановки — lifecycle.

Finish v2: draft/running→finished; повтор возвращает тот же Session. В одной транзакции
закрывается выдача pending assignments, фиксируются finished_at и interrupted_at.
Card.state сохраняется, новых enum «прервана» в Card нет. AttemptState отдельно:
completed только при настоящем terminal, active до finish, interrupted после finish.
Пересчёт не назначает ноль автоматически. Pending evaluate для законченной карточки
может завершиться; будущая выдача отменена; prediction незавершённой попытки без факта.
Активные calls безопасно заканчиваются с причиной session_finished (план хранения C-04),
запись UI останавливается, upload разрешён владельцу после finish с прежним лимитом.
`recording_status=upload_pending/failed` не считается виной ученика.

Дополнение 27.09. `Card.interrupted_at` (nullable, обязательное поле ответа) отдаёт отметку
прерывания в `/cards` и WS: по ней АРМ и доска останавливают таймеры прерванной попытки, иначе
они шли до «99:59+». `Session.started_at/finished_at` (nullable) — для выбора свежего идущего
занятия и часов занятия у преподавателя. `SessionLifecycle.remaining_assignments` — сколько
неотменённых назначений ещё не завершено (нет карточки или карточка не закрыта и не прервана;
окончательная «Не принята» не закрыта). Назначения после старта не добавляются, поэтому 0 у
идущего занятия — «все закончили»: кабинет предлагает завершить и через 15 с завершает сам.

Параллельная работа (27.09, Q11/FR-1.5). Доклад бригады готов через `available_after_s`
после отправки бригады (первый отвеченный звонок ей) или статуса `requires_state` — что позже;
отсчёт больше не зависит от текущего звонка. Если с бригадой идёт разговор — доклад выдаётся
в него; если нет — worker создаёт входящий звонок `Call.direction=inbound`, `state=ringing`
(миграция 0012) и шлёт `training.updated`. `CardTraining.incoming` перечисляет такие вызовы;
ответ — обычное `call_answer` с их `call_id`. Пока звонок бригады не отвечен, второй не
создаётся; если диспетчер сам дозвонился до бригады и услышал доклад, её входящий
завершается (`end_reason=report_heard`). Входящие не входят в критерий звонка (оценивается
адресат, выбранный диспетчером). Окончательная «Не принята» не занимает место в лимите
`parallel_cards`. [ASSUMPTION] направление звонка бригады заказчик не подтвердил (21.09).

После finish повтор уже принятого события возвращает прежний receipt; новое учебное
действие, включая накопленное до finish, →409 `session_finished` без изменения карточки.
Outbox сохраняет отказ для разбора, не удаляет и не меняет UUID/timestamp. Поздняя загрузка
записи — отдельная разрешённая операция. C-03 согласует lock session→assignment→card
со scheduler: невозможно доставить карточку после зафиксированного finish.

## I-BRIGADE → C-04, B-02, V-02

Уже есть Service, Call, card events, запись аудио, телефон из трёх цифр. Новая бригада
не заменяет Service, телефонный адресат не заменяет ни бригаду, ни ДДС назначения.

| Операция/тип | Назначение |
|---|---|
| GET `/services/{id}/brigades` → Brigade[] | Внутренние бригады одной службы |
| GET `/services/{id}/call-targets` → CallTarget[] | Адресаты, связь brigade_id nullable |
| GET `/cards/{id}/training` → CardTraining | Ручной выбор и только уже выданные сведения |
| GET `/cards/{id}/messages/{delivery_id}/audio?version=N` | Авторизованное аудио выданного сообщения |
| CardEvent `brigades_select` | payload `{brigade_ids:UUID[]}`: непустой уникальный набор |
| CardEvent `call_dial_target` | `{call_id,call_target_id,brigade_id:null|UUID}` |
| CardEvent `message_presented` | PresentationReceipt |
| CardEvent `message_failed` | PresentationFailure |

Все новые HTTP и действия сейчас 501 (C-04). Старые call_dial/answer/hangup работают.
Выбор — ручная замена полного набора бригад. C-04 проверяет активность и принадлежность
службе участника. **Выбор только после решения (28.09):** бригаду направляют после «Принята»
(памятка ДДС, стр. 21: «реагирование будет осуществляться»); пока карточка в `added`,
`received` или `rejected`, `brigades_select` отклоняется **409** `{code:"decision_required"}`.
CallTarget.service_id должен совпасть со службой бригады, бригада — активная бригада ДДС
участника; бригада другой службы — 422. **Звонок не требует выбора (28.09):** связь у
диспетчера ДДС есть со всеми своими бригадами, поэтому `call_dial_target` ненаправленной
бригаде принимается, а в `calls.refusal` записывается отказ на момент набора: `busy` —
бригада направлена на другую незакрытую карточку, `not_assigned` — вызов ей не назначен.
Такая бригада отвечает отказом и по этому звонку не докладывает, даже если её направят во
время разговора. Поле внутреннее: в Card/Call/WS не отдаётся, клиент выбирает фразу отказа
сам по `CardTraining` и тому же правилу; в оценку (`evalcore` `call`) оно передаётся.
Для адресата без бригады передаётся null. Backend сам разрешает
phone_ext/service_id по target; произвольный номер не подменяет эти связи.
На исторических calls новые связи nullable, service_id/dialed_ext сохраняются.

План `TrainingPlan` принадлежит **преподавателю** и версии ScenarioContent;
в нём есть ожидаемые действия и observable_defects. Он не включён в Card/Call/WS snapshot.
Дефект оценивается только если доступен в самой карточке либо в подтверждённом сообщении.
Наличие расхождения с недоступным разговором 112 не является доказательством ошибки.

План → выдача → подтверждённое предъявление → возможные повтор/сбой — разные записи:
`PlannedMessage.justifies_state` (необязательно) — статус, который обосновывает доклад
(оценка хода статусов, [evalcore](evalcore.md));
`PlannedMessage.available_after_s` от начала отвеченного исходящего звонка;
сообщение может быть выдано только в talking после этого срока.
`PlannedMessage.requires_state` (необязательно, 27.09) — бригада ждёт решения диспетчера:
доклад выдаётся только когда карточка дошла до этого статуса (или дальше по ходу дела),
а `available_after_s` отсчитывается от позднего из моментов «ответ на звонок» и «статус
поставлен». Без поля — прежнее поведение. `CardTraining.awaiting_state` называет статус,
которого ждёт следующий по плану доклад; отдаётся только при `hints_level ≥ 1`, иначе null.
Правило одно для выдачи и подсказки — `apps/api/app/api/training/gating.py`.
**Занятость бригад (28.09).** `CardTraining.available_brigade_ids` — бригады ДДС, которыми
диспетчер располагает на карточке: две; с четырьмя происшествиями у обучаемого в занятии —
три, с шестью — четыре (не больше активных в справочнике). `CardTraining.busy_brigades` —
бригады, направленные на другие незакрытые карточки этого обучаемого в занятии; `brigades_select`
с новой занятой или недоступной бригадой отклоняется 422. Бригада плана — роль, а не конкретная
бригада: доклады плана приходят от бригады, которую направил диспетчер. Роль остаётся за
направленной бригадой, с которой уже был разговор без отказа (подкрепление, направленное
позже, её не перехватывает, 28.09); если такой нет — за бригадой плана, если она направлена,
иначе — за первой направленной, не занятой другой ролью плана. `DeliveredMessage`
фиксирует delivery/card/call/participant/brigade/target, immutable message version,
audio asset/version/hash и delivered_at. Уникальность `(card_id,message_id,version)`;
повторный запрос сведений возвращает прежнюю delivery, не новую обязанность.

`playback_id` создаётся перед каждой попыткой playback и сохраняется при retry.
`message_presented` отправляется после реального `ended` аудио (или после явного
подтверждения прочтения видимого текста), не по таймеру, download, autoplay request
или факту доставки. Audio/text согласованы с выданной версией; несовпадение →409,
чужой delivery/call →404. Для audio обязательна audio_version, для text — null.
Ошибка проигрывания/обрыв → message_failed. Факт повторного проигрывания остаётся в
append-only журнале; «первое успешное предъявление» используется как начало обязанности.
Один playback не может одновременно считаться успешным и неуспешным; конфликт →409.
После успешного предъявления поздний failed другой попытки его не отменяет.
Если успешного предъявления не было, InformationEvidence.state=failed/delivered,
presented_at=null: штраф за содержание запрещён.

InformationEvidence — проекция журнала, не сам журнал. При state=presented обязательны
presented_at/presentation_event_id, failed_at/failure_reason=null; при failed наоборот;
delivered имеет все четыре null. UUID client_event_id обеспечивает прежнюю дедупликацию
по actor. EventReceipt остаётся прежним, затем UI обновляет GET training.
WS `training.updated {card_id,revision}` только инвалидирует чтение; reconnect всегда
заново GET training для доступных карточек. Событие пока не публикуется.

## I-EVAL → C-06, V-02/V-03, D-02, B-03

Старые `Evaluation`, `Report`, CSV, partial rules и override остаются без новой формулы.
Новые GET `/cards/{id}/analysis` → AttemptAnalysis и
`/reports/session/{id}/analytics` → SessionAnalytics реализованы C-06 в database
(25.09, `app/api/analysis`): время — `evalcore.timing` по снимку занятия, слои rules/llm
обязательны, llm до подключения судьи — pending, поэтому оценка partial с причиной;
address/grammar/semantic/information — unavailable до V-02; рекомендация — null до V-03.
Mock-режим по-прежнему 501.
Первый доступен владельцу-trainee, владельцу занятия-teacher и admin для чтения;
групповой отчёт — только владельцу-teacher. Ответы не содержат reference/ожидаемый текст.

- `AttemptAnalysis`: completed/active/interrupted, TimingResult, nullable evaluation,
  nullable prediction. Нет оценки → evaluation=null; настоящая оценка 0 сохраняется.
- `EvaluationAnalysis`: automatic_total отдельно от effective_total. Последний override
  по `(created_at,id)` при disagree заменяет total, agree сохраняет automatic_total.
  Учительский комментарий/reason и override_id доступны в своей попытке.
- `required_layers` и `layers`: complete допустим, когда каждый необходимый слой done
  с evidence, explanation и version. Иначе partial + непустые partial_reasons.
  Название провайдера и пустой ответ не подтверждают слой. not_applicable допустим
  только вне required_layers. Ключ layer не повторяется. Проверяет C-06.
- `ErrorCounts.input` — суммарное число независимых ошибок ввода; address/grammar —
  подкатегории. routing/status_flow/timing/call считаются отдельно и не прибавляются
  к input. Повторы одной ошибки/evidence не удваивают счётчик. null — слой не проверен,
  0 — проверен и ошибок нет. При непроверенном подслое общий input также null.
- TraineeAnalytics считает attempt_count по доставленным карточкам, не назначениям;
  evaluated_count — число карточек с оценкой, а не число версий/worker retries;
  complete_evaluation_count — число полных оценок. completed/interrupted — подмножества
  попыток, активные составляют остаток. Средний балл только по evaluated, при 0 — null.
  Средние длительности только по ненулевым в смысле **не-null** verified-измерениям v2;
  нулевое время включается. sample_count явно указан; estimated/invalid/legacy отдельно
  доступны в attempts, не смешиваются в среднем v2. Агрегат ErrorCounts=null, если хотя
  бы у одной учитываемой оценённой работы слой неизвестен; иначе сумма.
- PredictionObservation сохраняется до начала попытки, actual_* сначала null и один
  раз заполняются после завершения; прерванная попытка не становится нулём. actual_score
  — исходный automatic_total, поздний override хранится отдельно и применяется в
  рекомендациях/отчёте. made_at/actual_at, model_version/methodology_version обязательны.
- Recommendation — уровень/вес, направление, объём истории, версии и объяснимое evidence.
  Недостаточно данных → nullable recommendation, не выдуманная уверенность.

Python-сигнатуры: [iteration_contract.py](../packages/evalcore/evalcore/iteration_contract.py).
V-02 реализует `evaluate_additional(ctx, *, timing, information) -> SupplementalResult`;
`information` — только PresentedInformation из подтверждённых доступных событий.
V-03 реализует `predict_for_session(trainee, scenario, *, context: PredictionContext)
-> Prediction` по Protocol SessionPredictor, а также
`update_rating(trainee, history) -> Trainee` и
`recommend_level(trainee, history) -> Recommendation`; прежний predict не ломается.
PredictionContext v2 передаёт UUID snapshot занятия и его сохранённый TimingPolicy;
норматив не кодируется через log_time_mean. CalibrationObservation содержит
automatic/effective score и override_id, собственные snapshot_id/handling_normative_s
и timing_quality; неизвестные исторические сведения — null. Только прошлые
завершённые попытки (made_at < completed_at), без будущего результата.
Точное отображение полей, границы и примеры — [evalcore](evalcore.md). C-06 готовит
адаптер/сохранение/соединение слоёв. Эти Protocol — сигнатуры, не рабочие заглушки.

## I-CONTENT → C-05/C-07, D-01/D-03

Инвентаризация базы: GET/POST `/scenarios`, GET/PUT `/scenarios/{id}`, POST retire;
GET `/packs`, POST `/packs/generate`, GET `/jobs/{id}` **уже работают**.
Утверждение отдельного сценария — существующий PUT Scenario с status=approved.
Отдельных revise/preview/частичного approval/progress/materials/grammar API в базе нет.
Новый набор CRUD Scenario не создаётся.
**25.09 в database реализованы** `previewScenario` (детерминированный `evalcore.scenario`
по 046_24, ошибки → 422 с `details.path`), `getJobProgress`, `approvePack` (версия +1 как PUT,
квитанции request_id, миграция 0010) и `GET /scenarios/{id}/content` (происхождение по origin;
для заданий по билетам — ссылка на билет/задачу и SHA-256 PDF из `data/ticket_scenarios/manifest.json`).
`reviseScenario` и `PUT /scenarios/{id}/content` пока 501.

| Добавление | Вход → выход | Владелец |
|---|---|---|
| POST `/scenarios/preview` | ScenarioPreviewInput → ScenarioPreview | C-05 |
| POST `/packs/generate` с options | прежний GenerateInput + GenerateOptions → Job | C-05 |
| POST `/scenarios/{id}/revise` | ScenarioRevisionInput → прежний Job, 202 | C-05 |
| GET `/jobs/{id}/progress` | → JobProgress | C-05 |
| GET/PUT `/scenarios/{id}/content` | ScenarioContentInput → ScenarioContent | C-05 |
| POST `/packs/{id}/approve` | PackApprovalInput → PackApproval | C-05 |
| POST `/scenarios/{id}/grammar-check` | GrammarCheckInput → GrammarCheck | C-07/V-02 |
| GET/POST `/materials` | список / multipart file + MaterialMetadata → Material | C-07 |
| GET `/materials/{id}/content?version=N` | авторизованный файл | C-07 |
| POST `/sessions/{id}/materials` | MaterialAssignmentInput → Material[] | C-07 |

Все перечисленные **добавления** пока 501. Старый generate без options работает прежним
способом. Новые поля не передаются действующему worker и не меняют его payload.

GenerateOptions требует `request_id` (UUID); в корне GenerateInput и в заголовке
второго ключа нет. Клиент создаёт UUID v4 один раз до первой отправки и сохраняет
всё тело для повтора после потери ответа. Новый запуск или изменение параметров
требует нового ключа. Без options действует прежний generate без гарантии повтора
HTTP; `options=null` остаётся явным запросом нового режима с ответом 501.

Общие правила будущего C-05 для generate и revise:

- Область уникальности `(kind=generate, actor_id, request_id)`, actor_id берётся
  из авторизованного пользователя. Ключи общие для обеих операций, не по пакету:
  тот же ключ для другой operation или другого scenario_id в revise даёт 409.
- С receipt атомарно сохраняются operation, ID сценария из URL для revise и
  canonical JSON **всего** тела запроса. Порядок ключей объектов незначим,
  порядок всех массивов значим (включая author_kinds, incident_type_codes,
  scenario_ids, complications). Значения не сортируются и не дополняются defaults.
- После проверки текущих прав тот же ключ и то же содержимое возвращают 202
  с тем же сохранённым Job.id и актуальным status/error этого Job; не создаются
  новые job/pack/scenario и не перезапускаются done/failed. Для текущего состояния
  остаётся GET `/jobs/{id}`. Другой запрос с тем же ключом →409 без изменений.
- Проверки авторизации/роли/CSRF и доступа к сохранённому job/контенту выполняются
  до возврата receipt; повтор не обходит отзыв доступа. Повтор принятой revise
  распознаётся до проверки версии, которую эта же задача уже могла увеличить.
- Receipt и ключ сохраняются на весь срок хранения Job, включая done/failed;
  в этот срок ключ не освобождается. Конкурирующие повторы создают одну задачу.
  API переносит `options.request_id` в `payload.request_id`, сохраняя исходный
  GenerateInput в `payload.input`; для revise источник — корневой request_id.
  Равенство ключей проверяет C-05; новый случайный ключ worker не генерирует.

Пример тела `POST /packs/generate` для D-01 (повтор отправляет **то же тело**):

```json
{
  "count": 10,
  "level": 1,
  "service_id": "102",
  "seed": 42,
  "options": {
    "request_id": "00000000-0000-4000-8000-000000002299",
    "selection": {
      "author_kinds": ["system", "teacher"],
      "incident_type_codes": ["2020000"],
      "scenario_ids": []
    },
    "constructor": null
  }
}
```

Это форма будущего идемпотентного запроса, сейчас корректный ввод возвращает 501.
Отсутствующий/невалидный request_id внутри объекта options →422. Ответы 501
не сохраняют receipt и не доказывают реализацию успешного повтора.

Конструктор задаёт код типа, службу, адрес, пострадавших, осложнения, уровень/вес, seed.
Проверка неизвестного кода/связи →422. `ScenarioPreview.scenario` — прежний Scenario
с reference для teacher, proposed draft; сохранение — существующий POST.
`suggested_weight` — предложение, явный weight учителя приоритетен. Preview не пишет БД.
Чистая сигнатура капитана `evalcore/scenario.py:build(constructor) -> preview`
закреплена ScenarioBuilder; JSON формы строго ScenarioConstructor/ScenarioPreview.

ContentSelection.author_kinds задаёт источники системы/учителя/ученика, несколько значений
означают смешанный выбор. incident_type_codes обязателен и непуст, scenario_ids=[] означает
все подходящие; непустой список дополнительно ограничивает кандидатов. Это фильтр, не
обещание пропорций. Если кандидатов не хватает — явный 422/job.failed, не скрытый fallback.
count/level/service/seed остаются на прежнем месте GenerateInput; при constructor!=null
level/service/seed должны совпасть с внешними, иначе 422. Число вариантов определяется count.
ContentProvenance отделяет author_kind от прежнего origin template/llm/imported/trainee;
преподаватель не маскируется enum `origin=teacher`. Synthetic маркируется явно.
Факт импорта через teacher не означает самостоятельного авторства trainee (FR-3.7 открыт).

Revise: request_id + текущая version + непустой комментарий. Сценарий не назначен,
редактируем учителем-владельцем; C-05 сохраняет job и ожидаемую version. Worker перед записью
повторно проверяет version/назначенность. Конфликт после enqueue → job.failed с русской
причиной, без перезаписи новой правки; успешный результат draft, version+1 и audit.
Job.kind остаётся generate; discriminator operation внутри versioned payload (jobs.md).
Повтор request_id/body возвращает тот же Job по общим правилам выше; другое тело →409.

Частичное утверждение означает выбор **подмножества сценариев**, не частичный эталон.
PackApprovalInput содержит их ID/current version. Вся выбранная часть атомарна:
ошибка одного откатывает всё, невыбранные остаются draft. При успехе approved содержит
новые версии, remaining_draft_ids — остаток. Повтор request_id возвращает receipt;
тот же ключ с другим телом →409. assigned scenario неизменяем, для исправления нужна копия.
Если выбранный сценарий уже approved нужной версии, операция не увеличивает её повторно.
Пакет approved только когда все его элементы approved. Существующий PUT сохраняет A2:
неполный draft разрешён, непригодный approved/назначение/старт →422.

ScenarioContent — sidecar версии Scenario для provenance/training plan, не второй Scenario.
PUT требует текущую version, увеличивает её вместе с sidecar и audit; назначенный сценарий
не меняется (409). Старые сценарии читаются с training_plan=null, происхождение выводится
из origin без выдуманных source hash/author_id. План сведения не выдаётся trainee.

Grammar-check читает поля сохранённой версии; stale version →409, check не редактирует
текст. Диапазоны start/end — Unicode code points, полуинтервал [start,end), не UTF-16 offsets;
UI преобразует их перед подсветкой. При отсутствии словаря status=unavailable, reason
непустой, issues=[]; это не доказательство отсутствия ошибок. При complete version модели
обязательна. Проверка live-текста по мере ввода не добавляется.

Материалы: multipart file + metadata application/json, ≤10 МиБ, PDF/DOCX/JSON/XML/CSV,
проверка фактического MIME/структуры, sha256 считает сервер; пути хранения не принимаются.
В metadata и ответе Material обязательно `purpose: reference | evaluation`.
Ответы GET `/materials`, POST `/materials` и POST `/sessions/{id}/materials`
содержат purpose каждой возвращаемой версии, совпадающий с её MaterialMetadata.
Назначение — свойство immutable-версии: повторное чтение каталога после перезагрузки
сохраняет его без локального состояния формы загрузки. Отсутствующий, null или
неизвестный purpose не является reference по умолчанию и нарушает контракт.

Teacher получает в каталоге только свои материалы обоих назначений. Пример списка
в ответе GET `/materials` в OpenAPI содержит reference и evaluation; это пример
**каталога преподавателя**, не ответ ученику. D-03 показывает назначение в каталоге
и предлагает к назначению только reference. Фильтр по purpose в HTTP не вводится.

Evaluation доступен только владельцу-teacher, никогда trainee, включая метаданные
каталога и скачивание. Ученику доступны только назначенные версии reference его
занятий; знание ID/версии не даёт права на чужую или неназначенную справку.
GET `/materials/{id}/content?version=N` проверяет те же права на точную версию.
Для новой версии previous_id/previous_version оба заданы, иначе оба null;
optimistic conflict →409. Новые версии immutable, учебные назначения ссылаются на точную
версию, purpose=reference. Перед назначением сервер C-07 проверяет session draft,
владение занятием и каждым материалом, существование точной версии и её purpose=reference,
даже если UI уже отфильтровал каталог. Чужой/недоступный объект →404, недопустимое
назначение своего evaluation →422, не-draft занятие →409; повтор request_id/body
идемпотентен. Ответ назначения содержит только reference. Admin не получает доступ
к этим операциям через техническую роль. C-07 отдаёт MIME/download headers,
не исполняет XML/макросы. **25.09 C-07 реализовал все четыре операции в database**
(`app/api/materials`, миграция 0009: неизменяемые версии под триггером, назначения,
квитанции request_id; тип по содержимому, XML без DOCTYPE/ENTITY, DOCX без макросов,
скачивание с `no-store`/`nosniff`). В mock они по-прежнему 501. Грамотность (grammar-check) — V-02.
Evaluation-материалы C-06 использует только в следующем цикле с provenance, история
не переписывается. Определение admin UI и вся поставка — за пределами C-01.
