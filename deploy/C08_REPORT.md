# C-08 — локальная поставка и backup/restore (24.09.2026)

Ветка `feature/sol-c08`, отдельный worktree `XacatonMoscow-sol-c08`. Зона изменений:
`deploy/`, `.env.example`, `.dockerignore`, `.gitignore`. Общие стенды `arm112`,
`arm112-c01-check`, `arm112-dbcheck-20260922` и `arm112-gap-check` не менялись;
никакие их контейнеры, базы и volumes не удалялись.

## Реализовано

- Compose backup-контейнер на PostgreSQL 16.10: `pg_dump` custom format и архив
  пользовательского `audio-data` в 02:00 UTC ежедневно; ручной запуск, SHA-256,
  публикация завершённого снимка атомарным переименованием каталога. Старые архивы
  автоматически не удаляются.
- `restore.sh` отклоняет имя рабочего проекта и существующие DB/audio volumes. Восстановление
  выполняется в отдельном Compose-проекте из проверенного архива, в пустые БД/том аудио.
- llama.cpp читает только локальный GGUF (`-m`, не `-hf`), образ LLM имеет локальный тег и
  `pull_policy: never`. Скрипт `offline.py` собирает свежие образы, экспортирует их,
  модель и файлы запуска, записывает SHA-256/размеры, image IDs, исходный коммит,
  источник и лицензию модели. Он отклоняет неполные словари/голоса и грязный исходный код.
  Загрузка/проверка доступна без Python на целевой машине через `offline.sh`/`offline.ps1`.
- Nginx повторно разрешает имя `api` через Docker DNS после пересоздания контейнера.

## Фактическая проверка

Проверено на Windows/Docker Desktop 29.8.0. Созданы **только** проекты
`arm112-c08-source` и `arm112-c08-restored`; снимок лежит в игнорируемом
`XacatonMoscow-sol-c08/backups/backup-20260924T134720Z`. Исходный тестовый проект:
Alembic `0003`, seed 7 пользователей и 11 сценариев, аудио `c08-sentinel.wav`.

1. `docker compose -p arm112-c08-source -f deploy/docker-compose.yml build backup` — прошёл.
2. `up -d --wait db migrate`, seed и ручной `backup-once` — прошли;
   `database.dump`, `audio.tar.gz`, `metadata.txt` имеют успешный `sha256sum -c`.
3. `sh deploy/restore.sh arm112-c08-restored backup-20260924T134720Z` через Git Bash — прошёл.
   Целевой проект: 7 пользователей, 11 сценариев, Alembic `0003`; аудиофайл имеет
   SHA-256 `316a2e9529274903f4e1c40339c5c8fb1f71f0b91e7b983b1ffc77724fb5f4e9`.
4. Повторный `restore-into-empty` в тот же том вернул код 1 и сообщение
   `Target audio volume is not empty` без перезаписи.
5. Отдельный nginx на тестовой сети вернул `200 application/json` с `/api/health`
   до и после `up -d --no-deps --force-recreate api`.
6. Compose `config --quiet` для обычного и restore override, Ruff,
   `pytest deploy/tests/test_offline.py` (**1 passed**), проверки shell/PowerShell
   синтаксиса и `git diff --check` — прошли.
7. После добавления lock образ backup пересобран; повторный `backup-once` создал
   `backup-20260924T135649Z`, lock снят. `up -d --wait backup` запустил контейнер;
   внутри подтверждены `crond -f -l 8` и расписание `0 2 * * *`.

## Открытые зависимости и границы доказательства

- Seed сообщил, что `data/streets.csv.gz` и реальные voice-файлы отсутствуют;
  `data/voices/manifest.json` имеет статус `pending`. Локальной GGUF в репозитории
  также нет. Поэтому настоящий offline-bundle, чистая установка без сети и AI/voice
  runtime пока **не проверены**. Сборщик намеренно отказывает без этих входов.
- Cron-запуск ровно в 02:00 UTC не ожидался в тесте; проверен тот же `backup-once`
  вручную. Расписание задано в образе. Ежедневный мониторинг результата и хранение
  копии на отдельном носителе остаются операционной процедурой.
- При одновременной записи БД и аудио снимки могут отражать разные моменты;
  для строгой согласованности нужен короткий период без новых занятий.
- `audit_log` входит в полный дамп и код C-08 его не удаляет. Хранение Docker stdout
  в течение 6 месяцев зависит от настройки хоста и здесь не доказано. Отказ отдельного
  узла, горизонтальное масштабирование, CPU/RAM на целевом железе, Windows 10/11 и
  Ubuntu 20.04+, browser matrix, лицензии пока не подтверждены тестом C-08.
- `SHA256SUMS` обнаруживает порчу файла; для защиты от злонамеренной подмены всего
  комплекта требуется доверенная копия manifest/подпись. Проект не заявляет
  юридическую сертификацию по 149-ФЗ/152-ФЗ.

Повтор после готовности данных: создать комплект по `deploy/README.md`, проверить
`offline.sh` и `offline.ps1`, загрузить его на чистую машину без сети, запустить DB/seed/LLM,
сделать новый backup и restore в отдельный проект; записать SHA/версию ОС и результаты.

## Проверка на Linux (второй ПК) · 25.09.2026

Ветка `feature/captain-c08-offline` = `origin/main` (`147a437`) + `feature/sol-c08` (`16feeaf`), без конфликтов.
Arch Linux, Docker Compose 5.5.1. Отдельные проекты `arm112-c08-src` и `arm112-c08-dst`,
каталог бэкапов вне репозитория (`BACKUP_DIR`); стенд пользователя `arm112` не затрагивался,
тестовые проекты и их тома удалены после проверки.

| Шаг | Результат |
|---|---|
| `build backup api`, `up db`, `up migrate`, seed | прошли; Alembic `0006`, 7 пользователей, 11 сценариев, 3854 правила |
| Контрольный `c08-sentinel.wav` в `audio-data`, `backup-once` | `database.dump`/`audio.tar.gz`/`metadata.txt`: `sha256sum -c` OK |
| `sh deploy/restore.sh arm112-c08-dst backup-…Z` | прошёл; в восстановленной БД те же счётчики и ревизия |
| SHA-256 аудио после restore | совпадает с исходным (`34fa2490…4738`) |
| Повторный restore в занятый проект | отказ «already has data; restore requires fresh volumes» |
| Restore в проект `arm112` | отказ «Choose a NEW project name other than arm112» |
| `offline.py create` с поддельной моделью | отказ «no GGUF magic bytes»; с GGUF-заголовком — «Required data/streets.csv.gz dictionary is missing» |
| `deploy/tests/test_offline.py`, `ruff check deploy`, `sh -n`, `compose config` (обычный и `--profile llm`) | прошли |

Не проверено здесь: настоящий офлайн-бандл и установка на чистой машине без сети (нет справочника
улиц, голосов и GGUF-модели), срабатывание cron в 02:00 UTC, хранение stdout 6 месяцев, отказ узла
и масштабирование. `llm` теперь требует локальный образ `arm112-llm:0.1.0` и файл модели
(`LLM_MODEL_FILE`), без скрытой загрузки `-hf`.
