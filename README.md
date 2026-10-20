# Учебный симулятор диспетчера ДДС системы 112

Решение команды «Артифишл Интележенс» по задаче № 9 «Учебный симулятор подготовки диспетчеров
экстренных служб города по вызовам от системы 112» Международного хакатона ЛЦТ-2026.

Локальный веб-тренажёр рабочего места диспетчера дежурно-диспетчерской службы (ДДС). Обучаемый
получает карточку происшествия из системы 112 в АРМ, повторяющем экраны АРМ-112 по памятке ДДС,
принимает решение по своей службе, звонит учебной бригаде по встроенному IP-телефону, передаёт
адрес и повод — голосом или ответом «по частям», — исправляет неверно повторённый адрес,
принимает доклады бригады, отмечает этапы реагирования и закрывает карточку.

- **Оценка** — детерминированные правила: время реакции и отработки, статусы, адрес, звонок,
  доклады, комментарий; локальная ИИ-модель дополнительно проверяет смысл комментария.
  Разбор показывает, за что сняты баллы.
- **Преподаватель** готовит занятие, раздаёт задания из каталога сценариев, подаёт вводные по
  ходу, наблюдает за работой в реальном времени, переопределяет оценки с объяснением и выдаёт
  отчёты. С включённой локальной моделью флажок «ИИ подбирает задания» готовит набор карточек
  под уровень каждого обучаемого, а в студии ИИ создаёт новые сценарии на проверку.
- **Голос**: реплики бригад, служб и заявителей заранее озвучены; доклад диспетчера голосом
  распознаётся локально (faster-whisper), фраза — до 10 секунд.
- **Без интернета и без GPU**: всё работает на одной машине или в учебной сети класса. ИИ и
  распознавание речи — локальные и включаются при запуске; без них тренажёр работает на
  правилах и вариантах ответа.

Модуль «Оператор 112» (приём звонка заявителя) сохранён в коде и по умолчанию выключен;
администратор включает его в разделе «Модули».

## Документация

Пособия простым языком (редакция 20.10.2026):

- [Техническое описание](docs/submission/manuals/pdf/01_technical_description.pdf)
- [Руководство администратора](docs/submission/manuals/pdf/02_administrator_guide.pdf)
- [Руководство преподавателя](docs/submission/manuals/pdf/03_teacher_guide.pdf)
- [Руководство обучаемого](docs/submission/manuals/pdf/04_trainee_guide.pdf)

Редактируемые DOCX и исходники — в [docs/submission/manuals](docs/submission/manuals/).

Сопроводительная документация решения:

- [documentation.pdf](documentation.pdf) — редакция, сданная 29.09.2026, одним файлом.
- Разделы в Markdown — [docs/submission/documentation](docs/submission/documentation/README.md):
  1. [Назначение, функциональная и компонентная архитектура](docs/submission/documentation/01_architecture.md)
  2. [Методы обработки данных](docs/submission/documentation/02_methods.md)
  3. [Сборка, установка, эксплуатация](docs/submission/documentation/03_install.md)
  4. [Условия применения и ограничения](docs/submission/documentation/04_constraints.md)
  5. [Перечень библиотек](docs/submission/documentation/05_libraries.md)
  6. [Матрица «требование → реализация → проверка»](docs/submission/documentation/06_requirements_matrix.md)
  7. [Модуль «Оператор 112»](docs/submission/documentation/07_operator_112.md) — сверх задачи, по умолчанию выключен
  8. [Общее техническое описание](docs/submission/documentation/08_technical_description.md)
  9. [Руководство администратора](docs/submission/documentation/09_admin_guide.md)
  10. [Руководство преподавателя](docs/submission/documentation/10_teacher_guide.md)
  11. [Руководство обучаемого](docs/submission/documentation/11_trainee_guide.md)

## Быстрый запуск

Нужны Docker Engine или Docker Desktop (WSL2) с Docker Compose ≥ 2.24, от 8 ГБ ОЗУ и 10 ГБ диска.

Одной командой (Linux, macOS, Git Bash в Windows):

```sh
git clone https://github.com/DTYUI1/OneOneTwo-OnTheLine.git && cd OneOneTwo-OnTheLine
scripts/stand/up.sh                     # сборка, база, миграции, сценарии, запуск
scripts/stand/up.sh --stt local         # то же с распознаванием речи
scripts/stand/up.sh --ai local          # то же с локальной ИИ-моделью (файл модели — в models/)
scripts/stand/up.sh --lan               # открыть стенд другим компьютерам учебного класса
```

Вручную, теми же шагами:

```sh
cp .env.example .env        # задать JWT_SECRET (≥ 32 байт), DEMO_PASSWORD, API_MODE=database
docker compose build
docker compose up -d --wait db
docker compose run --rm --no-deps migrate
docker compose run --rm --no-deps api python -m app.seed
docker compose run --rm --no-deps api python -m app.seed.training
docker compose up -d --wait api worker web
```

Вход — `https://localhost:8443/app/login`, учётные записи `admin`, `teacher`,
`trainee01`…`trainee05`; пароль — `demo-local` при запуске через `up.sh` или `DEMO_PASSWORD`
из `.env` при ручном. Локальная модель, распознавание речи, установка без интернета, учебная
сеть и резервные копии — в [разделе 3 документации](docs/submission/documentation/03_install.md)
и [deploy/README.md](deploy/README.md).

## Что где лежит

```
apps/api/                  # API и фоновый обработчик: Python, FastAPI, SQLAlchemy, Alembic
apps/web/                  # АРМ, телефон, кабинеты преподавателя и администратора: React, TypeScript
packages/evalcore/         # детерминированная оценка действий обучаемого
contracts/                 # OpenAPI и JSON Schema — договорённости между API и интерфейсом
data/                      # сценарии, справочники, классификатор, озвученные реплики
deploy/                    # Docker Compose, локальные ИИ и распознавание речи, офлайн-комплект
qa/                        # e2e (Playwright), нагрузочные и smoke-проверки
scripts/                   # запуск стенда, сборка данных, голоса, документация
docs/                      # материалы задачи: ТЗ, ответы кейсодержателя, классификатор,
                           # скриншоты АРМ, датасет; docs/submission/ — документация решения
requirements/prd.md        # сводные требования
architecture/system_design.md  # архитектура и архитектурные решения
documentation.pdf          # сопроводительная документация (редакция 29.09)
```

Памятка ДДС «Работа на АРМ-112» из датасета в репозиторий не входит: в ней персональные данные
сотрудников заказчика (см. [docs/dataset/README.md](docs/dataset/README.md)).

Происхождение и лицензии голосов — [scripts/voices/PROVENANCE.md](scripts/voices/PROVENANCE.md)
и [scripts/voices/README.md](scripts/voices/README.md).

## Проверки

```sh
uv sync --all-packages --frozen
uv run ruff check . && uv run mypy
uv run --all-packages pytest -q
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm test:e2e              # браузерные сценарии на запущенном стенде
```
