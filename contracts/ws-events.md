# WebSocket v1

## Дополнение C-01: объявлено, реализация ожидает C-02/C-04

Машинный union дополнен `clock.ping.v2 {sample_id,client_ts}` /
`clock.pong.v2 {sample_id,client_ts}` (конверт содержит server_ts), а также
`training.updated {card_id,revision}`. Версия конверта остаётся 1: это новые type,
а не смена старых payload. Пока сервер принимает только clock.ping v1 и закрывает
новые/неподдерживаемые сообщения кодом 4400; событий training.updated не публикует.
Клиент переключается на v2 только вместе с C-02. Полная методика — [I-TIME](I-TIME.md).
**25.09:** database-сервер отвечает `clock.pong.v2` и публикует `training.updated` (C-02/C-04);
закрытие 4400 на v2 осталось только в mock.
Существующий server-side clock_offset_ms — односторонняя оценка, не проверенный midpoint.

CardEvent дополнен необязательным clock_sample_id и новыми действиями
brigades_select/call_dial_target/message_presented/message_failed. HTTP для них сейчас
возвращает 501, старые действия сохраняются. Точные payload и повтор/обрыв —
[I-BRIGADE](C01_INTERFACES.md). Plan/expected_comment в WS не попадают.
После C-04 training.updated доставляется только тем, кто может читать карточку,
и инвалидирует GET training; snapshot/reconnect также требуют этого GET.
Рендер/скачивание аудио не считаются message_presented.

## Действующий транспорт

Источник машинных типов: `components.schemas.WsServerEvent` и `WsClientEvent` в OpenAPI.
Пример: `contracts/examples/ws.json`. Один WebSocket `/ws` с JWT-cookie; origin должен
совпадать с текущим приложением. Обучаемый получает только собственные карточки.

Конверт сервера: `{schema_version: 1, event_id: UUID, server_ts: ISO-UTC, type, payload}`.

| type | payload | Потребитель |
|---|---|---|
| `snapshot` | `{cards: Card[], sessions: Session[], evaluations: Evaluation[]}` | shared: начальная синхронизация и reconnect |
| `presence` | `{user_id, online}` | live-доска |
| `card.appeared`, `card.updated` | `Card` | АРМ и live-доска |
| `session.started`, `session.finished` | `Session` | АРМ и пульт |
| `evaluation.partial`, `evaluation.complete` | `Evaluation` | результаты и пульт |
| `call.state` | `Call` | софтфон и live-доска |
| `clock.pong` | `{client_ts}` | shared, оценка разницы часов |

Клиент отправляет только `{type: 'clock.ping', client_ts: ISO-UTC}`.
Сервер возвращает этот timestamp и собственный `server_ts`.
`offset_ms = server_ts - (sent_client_ts + received_client_ts)/2`.
Пинг повторяется каждые 5 с. Оффсет служит для отображения таймеров; исходный `client_ts`
не переписывается. В рабочем backend оценка оффсета и RTT записывается отдельно (T-008).
В моке сохранённый `clock_offset_ms = 0` — это заглушка, не готовая оценка времени.

Действия идут **HTTP POST `/cards/{id}/events`**, а WS разносит подтверждённые изменения.
`client_event_id` создаётся один раз **до** записи в IndexedDB; UUID и timestamp неизменны при retry.
При потере ответа событие отправляется повторно; ответ содержит `duplicate: true`.
Повтор того же UUID с другим телом/карточкой → 409. Idempotency-key scoped по actor_id.

Очередь принадлежит `shared/ws/`, отделена по user_id, сохраняет порядок внутри
`(user_id, card_id)`. 2xx удаляет только подтверждённый элемент. Сеть/5xx/401
останавливают текущую отправку до восстановления, без записи постоянного failure.
Остальные отказы сохраняются с `failure` и останавливают следующие события **этой
карточки**; независимые карточки того же пользователя продолжают отправляться.
Отказ и зависимые события остаются в IndexedDB после retry/reload с исходными
UUID, timestamps, payload и sequence. Автоматического удаления, признания успехом
или повторной отправки постоянного отказа нет; требуется разбор через Outbox.list()
и PendingActions. Существующая структура IndexedDB v2 сохраняется без новой миграции.
Переподключение: 0.5 → 1 → 2 → 4 → 5 с, затем snapshot и HTTP-refresh.
В database-режиме API восстанавливает PostgreSQL LISTEN с теми же задержками
после стартовой ошибки или обрыва. Подключение, запросы и закрытие ограничены
5 с; проверка соединения каждые 5 с обнаруживает потерю транспорта без уведомления.
После успешной подписки API закрывает прежние WS с кодом 1012: браузер автоматически
переподключается, повторно проходит авторизацию и получает snapshot по текущим правам.
Это необходимо, поскольку NOTIFY не хранит события за время разрыва. Пропущенные
уведомления не воспроизводятся как новые события; состояние перечитывается из БД.
HTTP `/health` сохраняет прежние поля и код 200; общий `status` становится `degraded`,
пока LISTEN не готов, даже при `database: ok` и `worker: ok`. Compose healthcheck
сохраняет проверку доступности HTTP; готовность уведомлений видна в теле Health.
Snapshot означает замену отображаемого состояния, а не появление новой карточки.
Показ новой строки подтверждается `deliver` **после рендера** и получения состояния
её занятия через GET `/sessions/{id}`. Пока состояние неизвестно/недоступно или
занятие не running, АРМ не создаёт deliver/open, правки, переходы, redirect и события
звонков. Reload перечитывает состояние; session.started/session.finished обновляют
контекст карточки, snapshot инвалидирует его для HTTP-refresh.
Просмотр карточки и истории остаётся доступным. Завершение занятия останавливает
локальные таймеры/звук/запись софтфона без новых call-событий; повтор загрузки уже
записанного аудио закрытого звонка остаётся доступным в открытой карточке.
Сохранение аудио в IndexedDB после закрытия страницы здесь не добавляется.

Событие, созданное до finish, может быть получено сервером после него: сервер
сохраняет прежний 409, исходный конверт остаётся в очереди своей карточки.
Уже принятый UUID повторно подтверждается как duplicate и после finish.
Клиентская проверка не заменяет серверную и не реализует транзакционный finish v2.

Действия звонка: `call_dial {call_id, phone_ext}`, `call_answer {call_id}`,
`call_hangup {call_id}`. UI state machine: idle → dialing → ringing → talking → ended.
В моке переключаются dialing/talking/ended; гудки, ringing и запись — T-014.
Загрузка: `POST /calls/{id}/audio`, multipart поле `audio`, WAV/WebM/Ogg ≤ 10 МиБ.
В D1 upload отвечает 501; это явно проверяемый сценарий ошибки для софтфона.
Транскрипт nullable до T-036a. `audio_url` nullable до T-008.

Состояния карточки (дополнение C-01 24.09): added → received → accepted/rejected;
rejected → accepted или redirected; accepted → responding/arrived/working/completed/refused;
далее этапы только вперёд, до completed/refused. `open` не меняет статус.
Полный автомат и причина отказа — [I-TIME v3](I-TIME.md#v3).
Контроль переходов и расчёт 30/180 секунд — T-008/T-006. Мок хранит присланный статус без оценки.
