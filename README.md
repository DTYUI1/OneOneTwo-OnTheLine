# Учебный симулятор диспетчера ДДС системы 112

Решение команды «Артифишл Интележенс» по задаче № 9 «Учебный симулятор подготовки диспетчеров
экстренных служб города по вызовам от системы 112» Международного хакатона ЛЦТ-2026.

Локальный веб-тренажёр рабочего места диспетчера дежурно-диспетчерской службы (ДДС). Обучаемый
получает карточку происшествия из системы 112, принимает решение («Принята / Не принята»),
выбирает бригаду, передаёт сведения через учебный IP-телефон, отмечает этапы реагирования и
завершает карточку. Система оценивает действия по детерминированным правилам и локальной
ИИ-модели, преподаватель раздаёт задания, видит занятие в реальном времени, переопределяет
оценки и получает отчёты. Дополнительно — модуль «Оператор 112»: приём звонка заявителя с
голосом и разбором. Работает полностью локально, без интернета и без GPU.

## Документация

- [documentation.pdf](documentation.pdf) — сопроводительная документация одним файлом.
- Те же разделы в Markdown — [docs/submission/documentation](docs/submission/documentation/README.md):
  1. [Назначение, функциональная и компонентная архитектура](docs/submission/documentation/01_architecture.md)
  2. [Методы обработки данных](docs/submission/documentation/02_methods.md)
  3. [Сборка, установка, эксплуатация](docs/submission/documentation/03_install.md)
  4. [Условия применения и ограничения](docs/submission/documentation/04_constraints.md)
  5. [Перечень библиотек](docs/submission/documentation/05_libraries.md)
  6. [Матрица «требование → реализация → проверка»](docs/submission/documentation/06_requirements_matrix.md)
  7. [Дополнительный модуль «Оператор 112»](docs/submission/documentation/07_operator_112.md)

## Быстрый запуск

Нужны Docker Engine или Docker Desktop (WSL2) с Docker Compose ≥ 2.24, от 8 ГБ ОЗУ и 10 ГБ диска.

```sh
git clone https://github.com/DTYUI1/OneOneTwo-OnTheLine.git && cd OneOneTwo-OnTheLine
cp .env.example .env        # задать JWT_SECRET (≥ 32 байт), DEMO_PASSWORD, API_MODE=database
docker compose build
docker compose up -d --wait db
docker compose run --rm --no-deps migrate
docker compose run --rm --no-deps api python -m app.seed
docker compose run --rm --no-deps api python -m app.seed.training
docker compose up -d --wait api worker web
```

Вход — `https://localhost:8443/app/login`, учётные записи `admin`, `teacher`,
`trainee01`…`trainee05`, пароль — `DEMO_PASSWORD` из `.env`. Локальная ИИ-модель, установка
без интернета, резервные копии и доступ из локальной сети — в
[разделе 3 документации](docs/submission/documentation/03_install.md).

## Что где лежит

```
apps/api/                  # API и фоновый обработчик: Python, FastAPI, SQLAlchemy, Alembic
apps/web/                  # интерфейс АРМ, кабинеты преподавателя и администратора: React, TypeScript
packages/evalcore/         # детерминированная оценка действий обучаемого
contracts/                 # OpenAPI и JSON Schema — договорённости между API и интерфейсом
data/                      # сценарии, справочники, классификатор, учебные доклады
deploy/                    # Docker Compose, офлайн-комплект, резервное копирование
qa/                        # e2e (Playwright), нагрузочные и smoke-проверки
scripts/                   # сборка данных и документации, запуск стенда, голоса
docs/                      # материалы задачи: ТЗ, ответы кейсодержателя, классификатор,
                           # скриншоты АРМ, датасет; docs/submission/ — документация решения
requirements/prd.md        # сводные требования
architecture/system_design.md  # архитектура и архитектурные решения
documentation.pdf          # сопроводительная документация
```

Памятка ДДС «Работа на АРМ-112» из датасета в репозиторий не входит: в ней персональные данные
сотрудников заказчика (см. [docs/dataset/README.md](docs/dataset/README.md)).

## Проверки

```sh
uv sync --all-packages --frozen
uv run ruff check . && uv run mypy
uv run --all-packages pytest -q
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm test:e2e              # браузерные сценарии на запущенном стенде
```
