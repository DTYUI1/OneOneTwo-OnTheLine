# 3. Сборка, установка, эксплуатация

## 3.1 Требования

- Docker Engine (Ubuntu) или Docker Desktop с WSL2 (Windows 10/11), Docker Compose ≥ 2.24.
- CPU x86-64, ОЗУ от 8 ГБ (с локальной моделью — от 8 ГБ свободной памяти рекомендуется больше),
  диск от 10 ГБ; GPU не требуется.
- Браузер Chromium или Firefox актуальной версии на рабочих местах.

## 3.2 Установка из репозитория

```sh
git clone https://github.com/DTYUI1/OneOneTwo-OnTheLine.git && cd OneOneTwo-OnTheLine
cp .env.example .env        # задать JWT_SECRET (≥ 32 байт), DEMO_PASSWORD, API_MODE=database
docker compose build
docker compose up -d --wait db
docker compose run --rm --no-deps migrate                # Alembic; дождаться завершения
docker compose run --rm --no-deps api python -m app.seed  # справочники, классификатор, сценарии
docker compose run --rm --no-deps api python -m app.seed.training  # учебные бригады и доклады
docker compose up -d --wait api worker web
```

Вход: `https://localhost:8443/app/login` (комната — `https://localhost:8443/`). Учётные записи:
`admin`, `teacher`, `trainee01`…`trainee05`, пароль — `DEMO_PASSWORD`. Сертификат выдаёт
локальный CA: `docker compose cp certs:/certs/ca.crt ./ca.crt`, затем доверить его в ОС/браузере.
Для доступа из локальной сети до первого запуска задайте `WEB_BIND=0.0.0.0` и
`CERT_HOSTNAMES=localhost,127.0.0.1,<IP сервера>`.

Seed идемпотентен: повторный запуск не перезаписывает правки и синхронизирует классификатор.
`app.seed.training` добавляет по учебному сценарию на службу (номера 70004210…70004215) с
озвученными докладами первой бригады: обучаемый направляет бригаду, звонит на её прямой номер
из панели бригад и слышит доклады о выезде, прибытии, работах и завершении. Первое поколение
(70004200…70004205, без доклада о завершении) выведено в архив и не раздаётся.

## 3.3 Локальная ИИ-модель (опционально)

```sh
mkdir -p models   # файл Qwen3-4B-Instruct-2507-Q4_K_M.gguf (Apache-2.0) из офлайн-комплекта
# AI_PROVIDER=local в .env
docker compose --profile llm up -d --wait llm worker
```

Модель читается только из локального файла (`LLM_MODEL_FILE`), без загрузки из интернета при
запуске. Без модели (`AI_PROVIDER=off`) система работает, ИИ-слой помечается как невыполненный.

## 3.4 Установка без интернета

На подготовительной машине `deploy/offline.py create --output <каталог> --model <gguf>
--model-source … --model-license …` собирает образы, модель, файлы запуска и манифест с
SHA-256. На целевой машине `deploy/offline.sh load` (Linux) или `deploy/offline.ps1` (Windows)
проверяет хеши и загружает образы; далее `docker compose up --pull never --no-build` по шагам
раздела 3.2. Сборщик отказывает при неполных входных данных (справочник улиц, голоса).

## 3.5 Резервное копирование и восстановление

- Контейнер `backup` ежедневно в 02:00 UTC делает `pg_dump` и архив пользовательских файлов
  (записи докладов, учебные материалы) с SHA-256; вручную —
  `docker compose run --rm --no-deps backup backup-once`; из админки — «Копии и корзина» →
  «Сделать копию сейчас» (запрос в таблицу `backups`, контейнер забирает его в течение минуты
  через `backup-poll`; браузер команд на сервере не выполняет). Все копии и их результат видны
  там же. Папку `BACKUP_DIR` держите на отдельном диске.
- Удалённые администратором учётные записи обезличиваются только после успешной копии,
  начатой позже удаления (ТЗ: не удалять критичные данные без резервного копирования).
- Восстановление — только в новый проект и пустые тома:
  `sh deploy/restore.sh <новый-проект> backup-YYYYMMDDTHHMMSSZ`; восстановление в рабочий
  проект и занятые тома отклоняется. Проверено на Linux: счётчики, ревизия и SHA-256 файлов
  совпадают (`deploy/C08_REPORT.md`).

## 3.6 Обновление, диагностика, остановка

- Обновление: `git pull`, `docker compose build`, `docker compose run --rm --no-deps migrate`, затем
  `docker compose up -d --wait api worker web`. Откат схемы с новыми данными запрещён
  миграциями — используйте backup/restore.
- Состояние: `/api/health` (БД, ревизия схемы, heartbeat worker, ИИ-провайдер), раздел
  «Состояние системы» в админке, `docker compose ps`, `docker compose logs <сервис>`.
- Остановка без потери данных: `docker compose stop`; не используйте `down -v`, если данные нужны.
- Журналы: действия пользователей и изменения данных пишутся в `audit_log` в БД (бессрочно,
  входят в ежедневный backup). Журналы контейнеров ротируются (json-file, 30 файлов по 20 МБ на
  сервис). Для хранения stdout-журналов ≥ 6 месяцев выгружайте их на хосте по расписанию, например
  раз в сутки из cron: `docker compose logs --no-color --since 24h > /var/log/arm112/$(date +%F).log`.

## 3.7 Проверки разработчика

```sh
uv sync --all-packages --frozen && pnpm install --frozen-lockfile
DATABASE_URL_TEST=postgresql+asyncpg://… uv run pytest -q
uv run ruff check . && uv run ruff format --check . && uv run mypy
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm exec playwright test -c qa/playwright.config.ts   # на поднятом стенде, E2E_DATABASE=1
```

CI (GitHub Actions) выполняет те же проверки и браузерный набор на свежей БД и после
перезапуска с сохранённой историей.
