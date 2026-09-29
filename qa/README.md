# Кросс-зонные проверки

24.09: CI `database-e2e` на push/PR поднимает свежие образы, PostgreSQL, миграции, seed
и worker; запускает весь набор **28 тестов** в Chromium/Firefox с `E2E_DATABASE=1`,
затем повторяет его на той же истории после restart API и reload Nginx.
`smoke/c01_history.py` сохраняет хеши строк девяти таблиц и проверяет их неизменность,
включая карточки завершённых занятий без deliver/open. Новые строки разрешены.
Локально оба прогона прошли; удалённые результаты — во вкладке Checks
PR #14.
Каждый CI-run использует отдельное окружение runner; логи и трассы сохраняются артефактом.
Этот набор проверяет интеграцию, но не нагрузку класса, микрофон или качество голосов.

Этап 4 C-01 добавляет в тот же CI `session-isolation.spec.ts`: карточка завершённого
занятия без deliver/open, ожидание чтения состояния занятия, реальный 409 для действия,
созданного до finish, сохранение отказа после reload и работа новой карточки.
Также проверяются duplicate после finish, остановка гудков без новых call-событий
и повтор загрузки готовой записи закрытого звонка после finish. Для записи тест
использует синтетический Web Audio-сигнал в Chromium и встроенный тестовый микрофон
Firefox (`media.navigator.streams.fake`, `media.navigator.permission.disabled`).
Без аудиоустройства Linux Firefox не запускает AudioContext. В обоих браузерах
используется настоящий MediaRecorder; тест ждёт непустой пакет перед завершением
звонка, затем проверяет отказ загрузки и успешный retry. Физический микрофон не проверяется.
Тесты используют свои занятия/сценарии и сохраняют историю; старые данные не удаляются.

Этап 5 C-01 добавляет `realtime-recovery.spec.ts`: принудительный разрыв только
LISTEN-соединения, автоматический reconnect/snapshot и обновление открытого пульта
без reload или перезапуска API. Тест требует `E2E_DATABASE=1` и явного
`E2E_RECOVERY_PROJECT=arm112-c01-publish` (интеграционный локальный стенд),
`arm112-c01-stage6-final` (прежний итоговый стенд этапа 6),
`arm112-c01-stage5` (прежний стенд этапа 5) либо `arm112-ci-database` (CI).
Перед `pg_terminate_backend` проверяются Compose labels БД и единственное соединение
`application_name=arm112-realtime` в этой БД. Другие проекты не допускаются.
Команда для подготовленного отдельного стенда:
`node node_modules/@playwright/test/cli.js test -c qa/playwright.config.ts team-integration.spec.ts session-isolation.spec.ts realtime-recovery.spec.ts --workers=1 --forbid-only`.
Укажите `E2E_BASE_URL` этого стенда; при отсутствии recovery-переменных новый тест
пропускается. CI задаёт их явно. Управляемый пропуск NOTIFY и повторная проверка прав,
включая отозванную сессию, отдельно проверяются в `test_realtime_database.py` на
случайной pytest-БД. Старт API до готовности БД проверен отдельным Compose smoke;
команды и ограничения — в отчёте этапа 5.

Полный локальный рецепт: C01_START,
override `smoke/c01-publish.compose.yml` поверх `smoke/c01.compose.yml`,
проект `arm112-c01-publish`, HTTPS 43443. Запуск всех тестов без фильтра файлов:
`node node_modules/@playwright/test/cli.js test -c qa/playwright.config.ts --workers=1 --forbid-only`.
Для database transport фикстура сама создаёт свою карточку и подтверждает deliver;
тест не меняет первую попавшуюся карточку истории. Foundation допускает пустую
database-историю и сохраняет проверку фиксированной демо-карточки в mock.

`pnpm test:e2e` из корня: 3 роли, сохранение сессии при reload, запрет чужой зоны, logout,
ошибка пароля и комната → React — в Chromium и Firefox. Это smoke каркаса, не полный демо-скрипт T-017a.
Конфигурация сама запускает API/Vite; `E2E_BASE_URL` переключает на уже запущенный Compose.
Трассы ошибок — `qa/results` (gitignored). В CI браузеры запускаются отдельно от быстрых тестов.
`transport.spec.ts` дополнительно проверяет прямые входы teacher/admin (без потери внешнего порта),
10 одновременных WS-соединений одного аккаунта через proxy, snapshot/pong, доставку card.updated,
идемпотентный повтор HTTP-события и snapshot нового соединения. Это не нагрузочный тест 10/25 людей.
`smoke/`, `visual/`, `load/` предназначены для T-011/T-017; тесты backend лежат рядом с API.
