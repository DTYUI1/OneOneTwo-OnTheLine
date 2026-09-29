# Запуск и эксплуатация

Полная инструкция для экспертов — [`docs/submission/documentation/03_install.md`](../docs/submission/documentation/03_install.md);
здесь — то же коротко и детали эксплуатации.

## Быстрый старт (рабочий режим)

Нужны Docker Compose v2 ≥ 2.24 (поддержка `include`): Docker Engine на Ubuntu или Docker
Desktop с Linux containers на Windows. Первый build требует интернета для зависимостей и
образов; установка без сети — в разделе «Офлайн-комплект». Из корня репозитория:

```sh
cp .env.example .env     # PowerShell: Copy-Item .env.example .env
# в .env: API_MODE=database, постоянный JWT_SECRET (≥ 32 байт), свой DEMO_PASSWORD
docker compose build
docker compose up -d --wait db
docker compose run --rm --no-deps migrate                            # Alembic; дождаться завершения
docker compose run --rm --no-deps api python -m app.seed            # справочники, сценарии, учётки
docker compose run --rm --no-deps api python -m app.seed.training   # учебные бригады и доклады
docker compose up -d --wait api worker web
```

Рабочий режим — `API_MODE=database`: занятия, карточки, звонки, бригады с озвученными
докладами, оценка (rules + локальный ИИ-судья), разбор, аналитика, материалы, синхронизация
часов. Без `.env` Compose поднимает `API_MODE=mock` — статичный режим для разработки
фронтенда, `/api/health` в нём честно сообщает `database=not_connected`.

- Комната: https://localhost:8443/; вход: https://localhost:8443/app/login.
  Прямые входы: `/teacher` → `/app/teacher`, `/admin` → `/app/admin`.
- Учётки: `admin`, `teacher`, `trainee01`…`trainee05`, пароль — `DEMO_PASSWORD`.
- HTTP localhost:8080 перенаправляет на HTTPS; порт 443 хоста свободен для других проектов.
  По умолчанию порты доступны только с этой машины (127.0.0.1). Для доступа из LAN до первого
  создания сертификатов задайте `WEB_BIND=0.0.0.0` и
  `CERT_HOSTNAMES=localhost,127.0.0.1,<IP/имя сервера>`; существующие ключи не заменяются.
- Seed идемпотентен: повторный запуск не перезаписывает правки. `app.seed.training` создаёт
  по учебному сценарию на службу (номера 70004210…70004215) с докладами бригад; первое
  поколение 70004200…70004205 без доклада о завершении выведено в архив.
- `docker compose ps`: db/api/worker/web работают, certs и migrate успешно завершаются.
- `COMPOSE_FILE` в `.env.example` выбирает `deploy/docker-compose.yml`; без него `compose.yaml`
  включает тот же файл. Оба входа используют имя проекта `arm112` и одни тома.

Обновление: `git pull`, `docker compose build`, `docker compose run --rm --no-deps migrate`, затем
`docker compose up -d --wait api worker web`. Простой restart оставит старый образ.

Worker healthcheck (`python -m app.worker.healthcheck`) проверяет доступность БД с таймаутами
3 с / 1 с и не печатает DSN; свежесть heartbeat самого worker проверяет `/api/health`.

## Локальный CA

certs создаёт CA и серверный сертификат в отдельном volume, nginx использует TLS.
Скопируйте **только публичный** CA:

```sh
docker compose cp certs:/certs/ca.crt ./ca.crt
```

Если Docker не копирует из завершённого контейнера, `docker compose run --rm --entrypoint cat certs /certs/ca.crt`
покажет публичный сертификат. Ключ CA не распространяйте.
На АРМ: `./deploy/certs/install-ca.ps1 -CertificatePath ./ca.crt` (CurrentUser) либо
`sh deploy/certs/install-ca.sh ./ca.crt` (Ubuntu). Доверие устанавливается явным запуском команды.
Firefox может потребовать импорт CA в собственное хранилище. После доверия микрофон работает
в secure context. В локальной разработке localhost также допускает микрофон без TLS.

## Разработка без Docker

Python 3.12 + uv 0.8.22; Node 20 + pnpm 9.15.9. Два терминала в корне:

```sh
uv sync --all-packages --frozen
uv run --package arm112-api python -m app.api
```

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Открыть http://127.0.0.1:5173/app/login. Если настроена `.env` для TLS, для этого режима
поставьте COOKIE_SECURE=false (PowerShell: `$env:COOKIE_SECURE='false'`).
API hot reload: `uv run --package arm112-api uvicorn app.api.main:app --reload --host 127.0.0.1`.
Prism: `pnpm mock` → localhost:4010; отдельный Docker-профиль `docker compose --profile mock up --build`.
Prism статический, для login/WS нужен mock backend. API_TARGET меняет proxy Vite.
Для frontend-разработки с Vite, bind-mount и hot reload на 5173:

```sh
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.dev.yml --profile dev up --build -d --wait
```

Откройте http://127.0.0.1:5173/app/login. Override задаёт COOKIE_SECURE=false для HTTP и reload API.
Не используйте один `--profile dev` без override: Secure-cookie не предназначена для HTTP-входа.
Для возврата к обычному HTTPS остановите Vite и восстановите основной конфиг:

```sh
docker compose --profile dev stop web-dev
docker compose up --build -d --wait
```

Состояние mock API при пересоздании процесса сбрасывается — войдите заново. Том PostgreSQL
сохраняется. `docker compose stop` останавливает проект; не добавляйте `down -v`, если нужны данные.

Профиль `llm` запускает llama.cpp с локальным GGUF по `LLM_MODEL_FILE` (путь относительно
`deploy/`, по умолчанию `../models/qwen3-4b-instruct-2507-q4_k_m.gguf`). Параметра `-hf`
больше нет, поэтому контейнер не скачивает веса при старте. Для включения поставьте
`AI_PROVIDER=local` и `docker compose --profile llm up -d --wait llm worker`. Образ llama.cpp
должен уже иметь локальный тег `arm112-llm:0.1.0`; сборщик офлайн-комплекта создаёт его из
зафиксированного digest. Compose для этого сервиса запрещает pull.

Профиль `stt` (STT-01, необязательная «изюминка» — Q&A 16.09) поднимает распознавание
голосового доклада бригады: faster-whisper (small, int8, CPU) в отдельном образе
`deploy/stt`, модель — в слое сборки, в работе сеть не нужна. Включение: `STT_PROVIDER=local`
и `docker compose --profile stt up -d --wait --build stt worker`; на стенде — `scripts/stand/up.sh
--stt local`. Без профиля и переменной поведение не меняется (по умолчанию `off`). Текст
доклада не участвует в оценке карточки (contracts/jobs.md не менялся) — заявка на это решение
у владельца зоны, см. `scripts/ralph/brikkerdev/handoff.md`. В офлайн-комплект (`deploy/offline.py`)
образ пока не входит: это необязательная опция сверх обязательного скоупа.

## Backup и восстановление

`backup` запускается вместе с обычным Compose и делает `pg_dump` + архив `/data/audio`
ежедневно в **02:00 UTC**. Архивы лежат на хосте в `BACKUP_DIR` (по умолчанию `backups/`
в корне проекта). Контейнер пишет `database.dump`, `audio.tar.gz`, `metadata.txt` и
`SHA256SUMS` сначала во временный каталог и публикует каталог только после успешной проверки.
Существующие архивы автоматически не удаляются: для них нужно предусмотреть место, вывоз
на отдельный носитель и политику хранения. Содержимое `audit_log`, overrides, профили и
все остальные таблицы входят в полный дамп. При активной записи аудио делайте согласованный
backup в окно без новых занятий; суточная задача работает и без остановки, но файлы и снимок
БД могут относиться к соседним моментам времени.

Ручной снимок (из корня репозитория):

```sh
docker compose run --rm --no-deps backup backup-once
```

Проверьте хеши: `docker compose run --rm --no-deps backup sh -c
'cd /backups/backup-YYYYMMDDTHHMMSSZ && sha256sum -c SHA256SUMS'`.
Для восстановления нужен **новый** проект; скрипт откажет при наличии его DB/audio volumes,
а имя `arm112` запрещено. Пример на Ubuntu или Git Bash в Windows:

```sh
sh deploy/restore.sh arm112-restore-check backup-YYYYMMDDTHHMMSSZ
docker compose -p arm112-restore-check -f deploy/docker-compose.yml exec db \
  psql -U arm112 -d arm112 -c 'select count(*) from audit_log;'
```

Для фактических `POSTGRES_USER`/`POSTGRES_DB` используйте значения из `.env`. Сверьте число
строк ключевых таблиц, хеши файлов `/data/audio` и `/api/health` после запуска API с теми
же секретами приложения. Restore не запускает миграцию и не изменяет исходный проект.
Не используйте `down -v` для проекта с нужными данными. Файлы backup содержат данные и
должны храниться с доступом только у оператора. `SHA256SUMS` обнаруживает случайную порчу;
для защиты от подмены всего каталога сохраняйте манифест на доверенном носителе.

## Офлайн-комплект

На подключённой машине нужны `data/streets.csv.gz` (справочник улиц, в репозитории пока
нет) и локальная GGUF-модель; озвученные реплики и `data/voices/manifest.json` со статусом
`ready` уже в репозитории (лицензии — `scripts/voices/PROVENANCE.md`). Сборщик откажет при
неполном наборе. Зафиксируйте источник и лицензию модели.

```sh
python deploy/offline.py create --output offline-bundle \
  --model /path/to/qwen3-4b-instruct-2507-q4_k_m.gguf \
  --model-source 'точный источник и ревизия' --model-license 'лицензия из model card'
python deploy/offline.py verify offline-bundle
```

Команда собирает API/web/backup из чистого коммита, сохраняет Docker-образы (включая
PostgreSQL и llama.cpp), модель, Compose и `.env.example`. `manifest.json` содержит SHA-256
и размер каждого файла, ID каждого образа и источник модели. На чистой машине с Docker
Desktop/Engine и Compose ≥2.24 перенесите каталог целиком, отключите сеть и выполните:

```sh
cd offline-bundle
sh deploy/offline.sh verify
sh deploy/offline.sh load
cp .env.example .env
# задайте API_MODE=database, постоянный JWT_SECRET, POSTGRES_PASSWORD,
# согласованный DATABASE_URL и DEMO_PASSWORD
docker compose up -d --wait --pull never --no-build db
docker compose up -d --wait --pull never --no-build migrate
docker compose run --rm --no-deps api python -m app.seed
docker compose run --rm --no-deps api python -m app.seed.training
docker compose --profile llm up -d --wait --pull never --no-build
```

На Windows вместо двух команд `sh` используйте `./deploy/offline.ps1 verify` и
`./deploy/offline.ps1 load`, а вместо `cp` — `Copy-Item .env.example .env`. Seed выполняйте только
на новой БД; для обновления существующей БД сначала сделайте backup и следуйте миграциям.
Для доказательства отсутствия внешнего трафика нужен отдельный прогон на чистом хосте
с отключённой сетью. Этот прогон пока не выполнен из-за отсутствующих данных и модели.
При смене API nginx заново разрешает имя сервиса через Docker DNS каждые 10 секунд;
после пересоздания API проверьте `/api/health` и WebSocket.

## Проверки

```sh
uv run ruff check .
uv run ruff format --check .
uv run mypy
uv run --all-packages pytest -q
uv run --package arm112-api python -m app.tools.export_openapi --check
pnpm gen:api
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright install chromium firefox
pnpm test:e2e
```

E2E сам запускает локальные API/Vite. Для Compose: `E2E_BASE_URL=https://localhost:8443`
(в PowerShell `$env:E2E_BASE_URL='https://localhost:8443'`) и `pnpm test:e2e`.
CI (GitHub Actions) — на PR и после слияния в `main`: lint, типы, unit, контракты, сборка и
браузерный набор на свежей БД; полный Compose-прогон `compose-e2e` — вручную. Пока минуты
Actions исчерпаны, те же проверки выполняются локально перед merge (`CONTRIBUTING.md`).

Нагрузочные замеры (класс 23 АРМ, запись в БД, отчёт, 100 пользователей, ИИ-судья) — одной
командой `bash qa/bench/run.sh`, см. [`qa/bench/README.md`](../qa/bench/README.md).
