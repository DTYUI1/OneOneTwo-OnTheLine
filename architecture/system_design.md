# Архитектура OneOneTwoInTouch — учебный симулятор диспетчера ДДС (кейс C08)

> **Сверка 22.09.2026:** текущий порядок доработок — план v0.3, §0.1,
> смысл требований — [PRD §5.3](../requirements/prd.md). Модель/потоки ниже описывают текущую
> реализацию и исходный план v0.2. Выбор бригады и предъявление учебных телефонных сведений
> ещё требуют T-049/T-050; новых enum и incoming/outgoing этим документом не вводится.
> Эталон внутренних действий/сроков задаёт преподаватель; классификатор определяет условный
> подбор ДДС. 180 с — учебный тайминг, не норматив завершения физических работ.
> `scenario_code` и учебный `Scenario` остаются разными понятиями; источник —
> ответ заказчика.

> Версия 0.2, 2026-09-18. Основание — `requirements/prd.md` (сверен с финальным ТЗ от 01.09.2026).
> Статус: **принято командой 18.09** с уточнениями ADR-11…ADR-16 (архитектурный разбор 18.09).
> Источник истины по компонентам, контрактам и зонам ответственности. Правки — через PR с
> обновлением ADR (§9). План работ — `architecture/mvp_plan.md` v0.2, доп. фичи и решения по
> входу/ролям — `architecture/extra_features.md`.
>
> **Изменения v0.2 (кратко):** `ai` → `worker` без HTTP в одном пакете с `api` (ADR-11);
> три слоя ИИ: правила → эмбеддинги → LLM (ADR-12); `AI_PROVIDER=off` по умолчанию +
> предгенерированные пакеты (ADR-13); IRT + журнал прогнозов (ADR-14); TLS как условие работы
> микрофона (ADR-15); `client_ts`/`server_ts` + оффсет часов (ADR-16). Там, где текст ниже
> говорит «`ai`-сервис», читать «`worker`».

---

## 0. TL;DR

- **Три поставляемых части + БД**: `web` (SPA, копия АРМ ДДС + пульт преподавателя + админка),
  `api` (ядро: учётки, занятия, карточки, журнал действий, real-time), `ai` (генерация сценариев,
  оценка, голос), `db` (PostgreSQL). LLM-рантайм (`llm`, llama.cpp) — отдельный контейнер,
  **выключаемый**: без него всё работает на шаблонах и правилах.
- **Правила — первичны, LLM — вторичен.** Время, поля, статусы, маршрутизация по классификатору,
  адрес по справочнику улиц считаются детерминированно и объяснимо (пакет `evalcore`, без ИИ).
  LLM только (1) пишет правдоподобный текст сценария и (2) судит свободный текст обучаемого.
  Это прямой ответ на NFR-11 («сложная непонятная модель — минус») и на Q&A Q28 (CPU).
- **Всё тяжёлое — заранее и в очереди.** Сценарии предгенерируются до занятия; оценка —
  асинхронная задача (мгновенная часть по правилам + LLM-часть, когда готова). Никаких LLM-вызовов
  на пути «клик обучаемого → ответ интерфейса».
- **Масштабирование без кода**: новая ДДС = строка в таблице служб + правила из классификатора +
  голосовой профиль; новый критерий оценки = класс-плагин + вес в настройках; новый провайдер
  LLM/TTS = конфиг. Горизонтально: `api` stateless, очередь задач в БД, `ai`-воркеров сколько нужно.
- **Один `docker compose up`**, офлайн-бандл (образы + модели + сиды) для класса без интернета.

---

## 1. Границы и контекст

```
                       ┌─────────────────────────── учебный класс (LAN, без интернета) ───────────────────────────┐
                       │                                                                                           │
   Преподаватель ──────┼──► браузер ──┐                                                                            │
   (отдельный ПК)      │              │        ┌──────────┐   HTTPS/WSS    ┌──────────┐    SQL    ┌──────────────┐ │
                       │              ├───────►│  web     │───────────────►│  api     │──────────►│  db          │ │
   Обучаемые ×23 ──────┼──► браузер ──┤        │  nginx+  │   /api, /ws    │  FastAPI │           │  PostgreSQL  │ │
   (АРМ №1..23)        │              │        │  SPA     │                │          │◄──────────│  + pg_trgm   │ │
                       │              │        └──────────┘                └────┬─────┘  jobs     └──────┬───────┘ │
   Администратор ──────┼──► браузер ──┘                                         │ HTTP (внутр.)          │         │
                       │                                                        ▼                        │         │
                       │                                                   ┌──────────┐                  │         │
                       │                                                   │  ai      │◄─────────────────┘         │
                       │                                                   │  FastAPI │  читает/пишет задачи       │
                       │                                                   │  worker  │                            │
                       │                                                   └────┬─────┘                            │
                       │                                        OpenAI-compatible│HTTP                              │
                       │                                                        ▼                                  │
                       │                                                   ┌──────────┐    ┌────────────────────┐  │
                       │                                                   │  llm     │    │ backup (pg_dump,   │  │
                       │                                                   │ llama.cpp│    │ cron, ≥1/сутки)    │  │
                       │                                                   │ (опция)  │    └────────────────────┘  │
                       │                                                   └──────────┘                            │
                       └───────────────────────────────────────────────────────────────────────────────────────────┘
                                          ▲
                                          │ выключено по умолчанию (AI_PROVIDER=cloud) — только если разрешат интернет
                                          ▼
                                   облачный LLM (опция)
```

**Вне контура** (PRD §3.2): заявитель, оператор 112, реальный SIP/АТС, боевые системы. Точка
расширения под SIP задокументирована (§8), но не реализуется.

---

## 2. Компоненты и ответственность

| Компонент | Технологии | Что делает | Чего НЕ делает |
|---|---|---|---|
| **web** — SPA | React 18 + TypeScript + Vite; TanStack Query; native WebSocket; ECharts; CSS-модули с токенами, снятыми со скриншотов | SPA раздаётся с базового пути **`/app/`** (Vite `base: '/app/'`): `/app/login`, три зоны `/app/arm` (эмулятор АРМ ДДС — список происшествий, карточка «формата 112», статусы, софтфон), `/app/teacher` (пульт: раздача заданий, live-доска, лента вердиктов, студия сценариев, отчёты), `/app/admin` (учётки, службы, настройки, журналы, бэкапы) — в документах сокращённо `/arm`, `/teacher`, `/admin`. Статическая «комната» `intro/` — на `/` (вход обучаемого, `data-src` → `/app/login`); короткие ссылки `/teacher` → `/app/teacher`, `/admin` → `/app/admin` (302 в nginx) — вход преподавателя/админа мимо комнаты | Не считает оценки, не хранит состояние занятия (всё — через api). Никаких вызовов в `ai` напрямую |
| **api** — ядро | Python 3.12, FastAPI, SQLAlchemy 2 + Alembic, Pydantic v2, asyncpg; argon2 + JWT в httpOnly-cookie | Аутентификация и RBAC; пользователи/группы/АРМ; занятия (session) и назначения; жизненный цикл карточек; **журнал действий** (append-only); real-time (WS) обучаемым и преподавателю; очередь задач для `ai`; отчёты (SQL-агрегаты, CSV); аудит; настройки (нормативы, веса). Мгновенная rules-оценка через `evalcore` | Не вызывает LLM/TTS сам; не содержит логики генерации |
| **worker** — фоновые задачи и интеллект (v0.2, ADR-11; в v0.1 — «`ai`») | Тот же Python-пакет, что `api` — код в `apps/api/app/worker/`, один образ, entrypoint `python -m app.worker` — **без HTTP**; читает `jobs` (`SKIP LOCKED`), пишет результат, `NOTIFY`; клиент к `llm` (OpenAI-compatible); ONNX Runtime для эмбеддингов; Piper TTS (пре-рендер); Vosk STT; ffmpeg | **Планировщик появления карточек** (по `assignments.planned_at`, в т.ч. параллельные); генерация сценариев (`evalcore.scenario` × LLM-нарратив) с **эталоном**; предложение веса; полная оценка карточки (rules из `evalcore` + эмбеддинги + LLM-судья) с объяснением; журнал прогнозов; инсайты по группе; транскод записей → WAV/MP3; STT; учёт фидбэка преподавателя (few-shot из переопределений) | Не хранит своё состояние (всё в `db`); не общается с браузером; не имеет HTTP-API (контракт — таблица `jobs`, `contracts/jobs.md`) |
| **evalcore** — библиотека | Чистый Python, без фреймворков и без ML (чисто-Python библиотеки и словари-данные разрешены, напр. `spylls`); pytest; ставится в `api` и `worker`. **Зона Verwelius** | **Всё детерминированное:** критерии оценки (время, поля, статусы, маршрутизация, адрес, качество текста без LLM, звонок, рубрика доклада); агрегация в балл с весами и «критическими ошибками»; **адаптивность и прогноз** (IRT-1PL, `predict()`, калибровка, рекомендация веса — ADR-14); оценка веса сложности; нечёткое сопоставление адресов; парсер классификатора → правила маршрутизации; **конструктор сценариев и эталонов** (`evalcore.scenario`); оффсет часов (ADR-16); инсайты по группе; CLI `python -m evalcore` | Не знает про HTTP, БД, LLM. Вход — dataclass'ы/JSON, выход — dataclass'ы/JSON |
| **llm** — рантайм | `llama-server` из llama.cpp, GGUF-модель в volume `models/`; профиль compose `ai` | Локальный инференс, OpenAI-compatible `/v1/chat/completions`, структурированный вывод по JSON-схеме (grammar) | Ничего прикладного. Заменяется облаком через `AI_PROVIDER` |
| **db** | PostgreSQL 16 (ТЗ: ≥12), расширения `pg_trgm`, `unaccent` | Все данные, очередь задач (`SELECT … FOR UPDATE SKIP LOCKED`), `LISTEN/NOTIFY` для событий между процессами | — |
| **backup** | контейнер с cron + `pg_dump` | Дамп ≥1 раз в сутки в volume `backups/`, ротация; скрипт восстановления | — |
| **web-proxy** | nginx (в образе `web`) | TLS (локальный CA из `deploy/certs/`, сертификат устанавливается на АРМ — ADR-15), раздача `intro/` на `/` и SPA на `/app/`, редиректы `/teacher` → `/app/teacher`, `/admin` → `/app/admin`, прокси `/api` и `/ws` → `api` | — |

Принцип: **api — единственная точка входа для браузера**; `worker` и `llm` — приватная сеть compose.
`api` в классе — **один процесс** (WS-хаб в памяти); `LISTEN/NOTIFY` нужен для событий
`worker → api`. Несколько процессов `api` — задокументированный путь масштабирования (§8), не дефолт.

---

## 3. Модель данных (ядро)

```
users(id, login, password_hash, role[admin|teacher|trainee], full_name, is_active, created_at)
services(id, code[101|102|103|104|GKH|MOSLIFT|…], name, phone_ext(3 цифры), voice_profile, category, is_active, sort)
   └ routing_rules(service_id, incident_type_code, condition(jsonb), payload)   ← из classifier_v046.csv
incident_types(code, group_no, group_name, name, sign1, sign2, sign3, scenario_code, main_service_code, raw(jsonb))
streets(id, name, name_norm, okrug, district, source)                            ← справочник улиц Москвы (ГАР/OSM)

scenarios(id, version, level[1..4], weight(1..10), incident_type_code, target_service_id,
          card(jsonb "формат 112"), reference(jsonb эталон), complications(jsonb),
          origin[template|llm|imported|trainee], status[draft|approved|retired],
          author_id, ai_weight_suggestion, teacher_comment, created_at)
scenario_packs(id, title, created_by, filters(jsonb))  ← предгенерированный пакет к занятию
   └ scenario_pack_items(pack_id, scenario_id, order)

sessions(id, title, teacher_id, status[draft|running|finished], started_at, finished_at,
         settings_snapshot(jsonb: normatives, weights, parallel_cards, hints_level))
workstations(id, number 1..23, hostname?)                                        ← config/app.xml
session_participants(session_id, user_id, workstation_id, dds_service_id, level, rating_at_start)
assignments(id, session_id, participant_id, scenario_id, order, planned_at, status)

cards(id, assignment_id, number(8 цифр), appeared_at, delivered_at, opened_at, first_status_at, closed_at,
      state[added|received|accepted|rejected|responding|refused|completed|redirected],
      redirected_to_service_id, current(jsonb — редактируемая часть ДДС))
      ← delivered_at — ACK клиента о показе строки (ADR-16); current и card_events пишутся в одной транзакции
card_events(id, card_id, client_event_id, client_ts, server_ts, clock_offset_ms, actor_id,
            type[appear|deliver|open|field_change|status_change|comment|redirect|call_dial|call_answer|
            call_hangup|hint_open], payload(jsonb))                                  ← append-only (ADR-8, ADR-16)
calls(id, card_id, dialed_ext, service_id, started_at, answered_at, ended_at, audio_path?, transcript?)

predictions(id, card_id, participant_id, made_at, p_success, expected_score, expected_time_s, p_timeout,
            theta_before, b_scenario, model_version, actual_score?, actual_time_s?, actual_timeout?)
            ← журнал прогнозов: пишется ДО выдачи карточки, факт дописывается после (ADR-14)

evaluations(id, card_id, version, rules_scores(jsonb), semantic_scores(jsonb), llm_scores(jsonb), total,
            critical_flags(jsonb), explanation(jsonb: по критериям), model_info(jsonb),
            status[partial|complete], created_at)                                    ← три слоя (ADR-12)
teacher_overrides(id, evaluation_id, teacher_id, decision[agree|disagree], new_total?, criterion_patches(jsonb),
                  reason, teacher_comment(виден обучаемому), created_at)             ← журнал переопределений
trainee_ratings(user_id, theta, theta_var, history(jsonb))                       ← адаптивность (IRT, ADR-14)
settings(key, value(jsonb), updated_by, updated_at)                              ← веса, нормативы, флаги
audit_log(id, ts, actor_id, action, entity, entity_id, before(jsonb), after(jsonb), ip)
jobs(id, kind[generate|evaluate|insights|tts], payload, status, attempts, locked_by, run_after, result, error)
```

Ключевые решения:
- **Карточка = read-only часть от «112» (в `scenarios.card`) + редактируемая часть ДДС
  (`cards.current`)** — ровно то, что просил заказчик в Q12; какие поля редактируемы — в JSON-схеме
  карточки (`contracts/card.schema.json`), а не в коде.
- **`card_events` — единственный источник правды для оценки и аудита.** Оценщик восстанавливает
  таймлайн из событий, а не из «текущего состояния».
- **Сценарий и эталон — в одном JSON** (`contracts/scenario.schema.json`), ТЗ §12 «JSON для сценариев»
  выполняется буквально; импорт/экспорт пакетов — файлами.
- **Все нормативы и веса — в `settings` со снимком в `sessions.settings_snapshot`**, чтобы отчёт по
  прошедшему занятию не «плыл» при смене настроек.

---

## 4. Ключевые потоки

### 4.1 Подготовка занятия (преподаватель)
1. Выбирает категории (группы классификатора), уровень/вес, число сценариев, ДДС → `POST /packs/generate`.
2. `api` кладёт job `generate` → `ai` для каждого сценария: выбирает тип из классификатора
   (с учётом категории и веса) → адрес из `streets` (+ управляемая «порча» адреса для сложных
   уровней) → пострадавшие/осложнения по правилам → **LLM (если включён) пишет «описание со слов
   заявителя» и теги в рамках JSON-схемы**; без LLM — шаблонные формулировки → эталон из
   классификатора (службы, главная служба, ожидаемая последовательность статусов, адресат звонка,
   обязательные поля) → `evalcore.difficulty.suggest_weight()` → `scenarios(status=draft)`.
3. Студия сценариев: предпросмотр с подсветкой «правильного по мнению системы», поле комментария →
   `POST /scenarios/{id}/revise` (LLM правит по комментарию) → «утвердить» (частично/полностью).

### 4.2 Занятие (real-time)
1. `POST /sessions/{id}/start` — участники/АРМ/уровни, назначения «галочками» (разные сценарии
   разным местам).
2. Планировщик в **`worker`** (ADR-11) создаёт `cards` по расписанию (в т.ч. **параллельные**:
   вторая карточка через N секунд после первой, N зависит от уровня); перед созданием пишет
   `predictions` (ADR-14) → `NOTIFY` → `api` шлёт WS `card.appeared` обучаемому и преподавателю;
   клиент отвечает событием `deliver` → `cards.delivered_at`.
3. Обучаемый: открыть → `card.open`; статус Принята/Не принята (+комментарий) → «карандаш» →
   Начало реагирования / Отказ / Работы завершены; перенаправить → выбор службы; звонок →
   софтфон: набор 3-значного номера → `call.dial` → `ai`/пре-рендер отдаёт «Слушаю вас» голосом
   профиля службы → (доклад, опц. запись) → «Я вас понял, информация принята» (Q14) → `call.hangup`.
   Каждое действие — `POST /cards/{id}/events` (идемпотентно по client_event_id, буферизация в
   браузере при обрыве сети ≤30 с — NFR-7).
4. При закрытии карточки `api` **сразу** считает rules-часть (`evalcore`, миллисекунды) →
   `evaluations(status=partial)` → WS `evaluation.partial` преподавателю; ставит job `evaluate` →
   `worker` добавляет эмбеддинг-оценку (`text_semantic`, миллисекунды) и, если LLM включена,
   LLM-оценку текста → `status=complete` → WS `evaluation.complete`; дописывает факт в `predictions`.
   Обучаемый видит результат на своём экране (балл, объяснения, эталон, комментарий преподавателя).
5. Преподаватель на live-доске: у каждого АРМ — текущая карточка, таймеры (30 с / 3 мин, красная
   индикация), последние события; лента вердиктов с «согласен / не согласен» →
   `teacher_overrides` + аудит. Адаптивность: после каждой оценки `evalcore.adaptive.update()`
   обновляет рейтинг и предлагает следующий вес (преподаватель может принять одной кнопкой).
6. `POST /sessions/{id}/finish` в любой момент → job `insights` (типичные ошибки группы).

### 4.3 Отчёты
`GET /reports/session/{id}` — по обучаемому (ФИО, АРМ, балл, времена и отклонение от норматива,
число ошибок ввода, уровень) и по группе (лидеры/отстающие **и почему** — топ-3 критерия с самым
низким вкладом); графики строит `web` (ECharts) по тем же JSON; `?format=csv` — выгрузка (ТЗ §12);
PDF — опция.

---

## 5. Оценщик (`evalcore`) — объяснимость по построению

```python
@dataclass
class CriterionResult:
    key: str            # "reaction_time", "address", ...
    score: float        # 0..1
    weight: float       # из settings
    critical: bool      # блокирующая ошибка (напр., адрес ведёт в другую улицу)
    evidence: list[str] # факты: "реакция 42 с при нормативе 30 с"
    explanation: str    # 1–2 предложения для преподавателя/обучаемого

class Criterion(Protocol):
    key: str
    def evaluate(self, ctx: EvalContext) -> CriterionResult: ...

# EvalContext = карточка(reference + current) + события + звонки + настройки + справочники
```

Критерии MVP (регистр `evalcore.criteria.REGISTRY`, новые добавляются классом + весом):

| key | Что проверяет | Как | Источник |
|---|---|---|---|
| `reaction_time` | появление → открытие ≤ 30 с | кусочно-линейная шкала: ≤норматива → 1; штраф за превышение; параллельные карточки учитываются | Q11 |
| `handling_time` | открытие → закрытие ≤ 3 мин | то же | Q11 |
| `status_flow` | последовательность статусов соответствует эталону (принята → начало реагирования → завершены; отказ обоснован) | конечный автомат из `reference.expected_flow` | §5.3 |
| `routing` | принята/отклонена/перенаправлена правильно для своей ДДС; выбранная служба при перенаправлении — по классификатору | сравнение с `routing_rules` | КЛАСС |
| `required_fields` | обязательные редактируемые поля заполнены | по JSON-схеме карточки | Q10 |
| `address` | адрес в комментарии/полях совпадает с эталоном; «Дубнинская ≠ Дубининская» | нормализация + `pg_trgm`/Дамерау-Левенштейн по `streets`; порог настраиваемый; расхождение улицы = critical | Q10 |
| `text_quality` | опечатки, длина, наличие ключевых сущностей (кто направлен, куда, когда) | словарь + правила; **без LLM** | Q10 |
| `call` | звонок сделан, нужному адресату, вовремя | `calls` vs `reference.expected_call` | Q14 |
| `call_report` *(уровень C)* | доклад по телефону содержит адрес, тип, что направлено, время | рубрика по транскрипту STT (`calls.transcript`); без транскрипта — «не оценивалось» | Q14 «изюминка» |
| `text_semantic` *(worker, слой 2)* | смысловая близость комментария к эталонному докладу, покрытие обязательных сущностей | эмбеддинги `rubert-tiny2` (ONNX, CPU, мс) → косинус к `reference.expected_comment`; объяснение «близость 0,82; не названо: кто направлен» | ТЗ §5 «нейросетевой анализ», ADR-12 |
| `text_llm` *(worker, слой 3, опция)* | понятность следующему звену, полнота относительно эталона | LLM-судья по рубрике, короткий JSON (≈ 60 токенов) с цитатами; few-shot из `teacher_overrides`; при `AI_PROVIDER=off` — «не оценивалось» | Q10, Q13 |

Итог: `total = Σ wᵢ·sᵢ / Σ wᵢ`, при `critical` — потолок (по умолчанию 0.5). Дефолты весов —
в `settings`, преподаватель меняет. **Калибровка по фидбэку** (прозрачное «дообучение»): по
накопленным `teacher_overrides` подбираются веса методом наименьших квадратов, результат
предлагается администратору/преподавателю, не применяется молча.

**Адаптивность и прогноз (ADR-14, «как в шахматах», но проверяемо)**: модель IRT-1PL (Раш):
способность обучаемого θ, сложность сценария b (стартует от веса 1–10, уточняется по данным);
`P(success) = σ(θ − b)`; обновление θ градиентным шагом по результату (Elo — частный случай с
фиксированным шагом). Время отработки — лог-нормальная EWMA по последним карточкам →
`p_timeout = P(t > норматив)`. **Перед выдачей карточки** `evalcore.predict()` пишет в
`predictions` `{p_success, expected_score, expected_time, p_timeout}`; после закрытия дописывается
факт. Отчёт показывает «прогноз vs факт» (калибровочная кривая, Brier score) — это ровно то, что
ТЗ §17 называет «сравнение реальных данных и прогнозных значений». Рекомендация следующего веса —
сценарий с `P(success) ≈ 0,7` («зона ближайшего развития») с текстовым объяснением: «рейтинг 5,8 →
вес 6, вероятность успеха 68 %». Все формулы и константы — `docs/evalcore_formulas.md`,
воспроизводимы через `python -m evalcore` (ТЗ §16 «проверка работы расчётов»).

---

## 6. Контракты

| Контракт | Где | Кто владелец | Потребители |
|---|---|---|---|
| OpenAPI `api` | генерируется FastAPI → `contracts/openapi.json`; TS-клиент генерируется в `web` (`src/api-client/`, **коммитится**, CI проверяет отсутствие диффа после регенерации). Соглашения: CSRF — double-submit (cookie `csrf` + заголовок `X-CSRF-Token` на мутациях); CSV — UTF-8 с BOM, разделитель `;`, даты ISO-8601; ошибки — `{code, message, details}` | api | web |
| WS-события | `contracts/ws-events.md` + Pydantic/TS-типы: `card.appeared/updated`, `session.started/finished`, `evaluation.partial/complete`, `call.state`, `presence` | api | web |
| Сценарий/эталон | `contracts/scenario.schema.json` | ai (+evalcore) | api, web, импорт/экспорт |
| Карточка «формат 112» | `contracts/card.schema.json` (read-only/editable, обязательные поля, маски) | web (по скриншотам) + api | все |
| `evalcore` API | `packages/evalcore/README.md`: `evaluate(ctx) -> Evaluation`, `predict(trainee, scenario) -> Prediction`, `adaptive.update(...)`, `calibration(...)`, `suggest_weight(scenario)`, `address.match(...)`, `scenario.build(spec) -> Scenario`, `clock.correct(...)`; CLI `python -m evalcore` | evalcore (Verwelius) | api, worker |
| Очередь задач | `contracts/jobs.md`: виды `generate | evaluate | insights | transcribe | tts`, payload и результат каждой; таблица `jobs` — единственный канал `api → worker` (ADR-11) | api | worker |
| Провайдеры | `apps/api/app/worker/providers/{llm,embeddings,tts,stt}/base.py` — интерфейсы; реализации `local_llamacpp`, `openai_compat`, `mock`, `rubert_onnx`, `piper_prerendered`, `vosk`, `null`; выбор — `AI_PROVIDER`, `EMBEDDINGS_PROVIDER`, `TTS_PROVIDER`, `STT_PROVIDER` | worker | worker |
| Комната ↔ приложение | `intro/README.md`: `data-src`, `postMessage {type:'arm112:exit'}` (+ `arm112:alert` — идея); iframe с `allow="microphone; autoplay"` | web (Qwots) | intro |

Главные REST-группы `api`: `/auth`, `/users`, `/services`, `/incident-types`, `/scenarios`,
`/packs`, `/sessions`, `/assignments`, `/cards`, `/calls`, `/evaluations`, `/overrides`, `/reports`,
`/settings`, `/admin/{health,logs,backups,audit}`, `/ws`.

---

## 7. Голос, LLM, справочники — как это работает без интернета и GPU

- **Телефония**: софтфон — компонент `web` (клавиатура 3 цифры, гудок/КПВ через Web Audio,
  таймер разговора, справочник телефонов). Реплики адресата (2–3 фразы × N голосовых профилей)
  **пре-рендерятся на этапе сборки** Piper TTS (ONNX, CPU; русские голоса
  `ru_RU-irina/denis/dmitri/ruslan`, темп через `length_scale`) в `data/voices/`. **Лицензия:** пакет
  `piper-tts` 1.2.x — MIT, а ветка ≥ 1.3 (`piper1-gpl`) — GPL-3.0 `[LIKELY]`; поэтому пин
  `piper-tts==1.2.0` в `scripts/` как **инструмент сборки**, в рантайм-образ Piper не входит; лицензии
  самих голосов — из MODEL_CARD каждого голоса в `data/voices/README.md` (перечень библиотек — ТЗ §13). Рантайм-TTS
  через `worker` — опция для произвольных фраз. Доклад обучаемого — запись в браузере
  (`MediaRecorder` → WebM/OGG Opus) → `worker` транскодирует ffmpeg в **WAV 16 kHz mono** (ТЗ §12;
  этот же файл идёт в STT) и MP3 для прослушивания. **`MediaRecorder` работает только в secure
  context** (HTTPS или `localhost`) — см. ADR-15; iframe комнаты — с `allow="microphone"`.
  STT (Vosk small ru, ~50 МБ, CPU в реальном времени) — уровень C, принят в план после
  интеграции-1; транскрипт оценивает `evalcore.call_report`.
- **Три слоя ИИ (ADR-12)**: (1) правила `evalcore` — всегда, мгновенно; (2) **эмбеддинги**
  `rubert-tiny2` (≈ 30M параметров, ~120 МБ, ONNX Runtime без torch, миллисекунды на CPU) —
  всегда, офлайн, закрывают «нейросетевой анализ» из ТЗ; (3) **LLM** — опция, только вне горячего
  пути. Арифметика, почему так: 7–8B Q4 на i7 ≈ 5–8 ток/с → ~30 с на один свободный текст →
  23 обучаемых × 5 карточек ≈ час на одном воркере. Поэтому судья работает на модели **≤ 4B по
  умолчанию** (7B — опция после замера), выводит короткий JSON (≈ 60 токенов), рубрика —
  в системном промпте с prefix-cache `llama-server`.
- **LLM**: `llama-server` + GGUF с хорошим русским; кандидаты для замера на целевом CPU (D5,
  `docs/llm_benchmark.md`): 3–4B (Qwen2.5-3B-Instruct / Qwen3-4B без thinking / T-lite-мини) и
  один 7–8B (Qwen2.5-7B-Instruct, YandexGPT-5-Lite-8B, T-lite). Структурированный вывод по
  JSON-схеме (grammar) — без «свободных» ответов. Все промпты — файлы `apps/api/app/worker/prompts/*.md`,
  версионируются; `model_info` пишется в каждую оценку. Режимы `AI_PROVIDER=local|cloud|off`;
  **по умолчанию `off`** (ADR-13): генерация — `evalcore.scenario` + шаблонные тексты, оценка —
  слои 1–2, а в поставке лежат `data/packs/*.json` — пакеты сценариев, сгенерированные LLM заранее.
  Модель (2–5 ГБ) не входит в git и в образ — только в офлайн-бандл или скачивается скриптом.
- **Справочник улиц Москвы**: скачивается **один раз на этапе сборки** (не в рантайме — в классе
  интернета нет) из открытых данных. Основной источник для MVP — **OSM через Overpass API**
  (проверено 18.09: доступ есть, ~42 тыс. именованных дорог Москвы → ~5 тыс. уникальных улиц;
  лицензия ODbL, указать источник). Официальный «Общемосковский классификатор улиц Москвы
  (ОМК УМ)» на data.mos.ru — точнее (округ/район, официальные написания), но экспорт требует
  регистрации на портале; если выгрузка появится — слить в тот же `streets`. ГАР/ФИАС — запасной.
  Геокодер-API (Яндекс, 2ГИС) **не подходит**: нужен интернет, а условия использования запрещают
  хранить выгрузку офлайн. Выгрузка — `scripts/fetch_streets.py` → `data/streets.csv.gz` (в git);
  в таблицу `streets` с `pg_trgm` загружает `app.seed` (T-007).
- **Классификатор** → `scripts/build_classifier.py` (парсер — `evalcore.classifier`) →
  `data/classifier.json`; в `incident_types` + `routing_rules` загружает `app.seed` (T-007); 23 группы / ~1300 типов / ~70 служб. Приоритетные ДДС MVP:
  101, 102, 103, 104, ЖКХ, Мослифт — остальные включаются флагом `services.is_active`.

---

## 8. Масштабируемость и точки расширения (NFR-12)

| Расширение | Что делать | Кода |
|---|---|---|
| Новая ДДС / служба | строка в `services` + правила из классификатора (уже есть) + голосовой профиль + номер | 0 |
| Новый критерий оценки | класс `Criterion` в `evalcore.criteria` + вес в `settings` | 1 класс |
| Новый источник сценариев (96 билетов, когда придут) | `ai/generators/imported.py` → JSON по схеме | 1 модуль |
| Другой LLM / облако | `AI_PROVIDER`, `LLM_BASE_URL`, `LLM_MODEL` | 0 |
| Другой TTS/STT | реализация интерфейса провайдера | 1 модуль |
| Больше классов / пользователей | `api` stateless (JWT), N реплик за nginx; события между процессами — `LISTEN/NOTIFY` (готово) или Redis pub/sub (замена одного адаптера); `ai`-воркеры — по числу ядер | конфиг |
| Реальный SIP (будущее) | софтфон общается с `api` событиями `call.*`; замена компонента-софтфона на SIP.js/WebRTC-клиент к локальной АТС не трогает оценку и данные | 1 компонент |
| Мобильная/планшетная версия (ТЗ §15) | SPA адаптивна по сетке; АРМ — десктоп, пульт/отчёты — планшет | CSS |

---

## 9. ADR — архитектурные решения

| # | Решение | Альтернативы | Почему |
|---|---|---|---|
| ADR-1 | **Модульный монолит `api` + отдельный `ai`-сервис**, а не микросервисы и не единый монолит | (а) один процесс со всем; (б) 5+ микросервисов | `ai` тяжёлый, нестабильный по времени и выключаемый — его нужно изолировать и масштабировать отдельно; остальное — обычный CRUD+realtime, дробить нечего (NFR-11) |
| ADR-2 | **Python/FastAPI** для `api` и `ai` | Node/NestJS, Go | `evalcore` и ML-обвязка — Python; одна кодовая база для оценщика в `api` (мгновенно) и `ai` (полно); OpenAPI из коробки → типизированный клиент для `web`; AI-агенты команды сильнее всего в Python/TS |
| ADR-3 | **React + TypeScript + Vite** для `web`, без UI-кита | Vue, Svelte, HTMX + серверные шаблоны | Нужна пиксельная копия чужого АРМ — UI-кит мешает; React — максимум экосистемы и опыта агентов; TS-типы генерируются из OpenAPI |
| ADR-4 | **Правила первичны, LLM — только для текста**, всё объяснимо по критериям | LLM оценивает всё «целиком»; классификатор-ML на размеченных данных | Нет данных для обучения (билеты не получены, методики нет); заказчик требует объяснимость, настраиваемые веса и простоту (Q10, Q24); CPU |
| ADR-5 | **Очередь задач в PostgreSQL** (`SKIP LOCKED`), события между процессами — `LISTEN/NOTIFY` | Redis + Celery/RQ; RabbitMQ | Один лишний stateful-сервис — лишняя точка отказа в классе без админа; нагрузка 23 клиента ничтожна; Redis — задокументированная замена адаптера при росте |
| ADR-6 | **Предгенерация сценариев + асинхронная оценка** | генерация/оценка онлайн по клику | Прямая рекомендация модератора Q28; на CPU 7B-модель даёт единицы токенов/с; демо с 10 экспертами не должно «отваливаться» (Q25) |
| ADR-7 | **Пре-рендер реплик телефона Piper TTS на сборке**, рантайм-TTS — опция | рантайм-TTS всегда; готовые mp3, записанные людьми | Реплики фиксированы (Q14, Q29) → нулевая задержка и нулевой риск на демо; Piper — MIT, CPU, русские голоса; при этом «TTS разными голосами» — честно выполнено |
| ADR-8 | **`card_events` append-only как источник правды** | хранить только текущее состояние карточки | Оценка по времени и последовательности требует таймлайна; аудит (ТЗ §9) получается бесплатно; воспроизводимость вердикта при пересчёте с новыми весами |
| ADR-9 | **JWT в httpOnly-cookie + argon2, TLS self-signed на nginx** | сессии в БД; Keycloak | ТЗ: логин/пароль, 3 роли, без 2FA; Keycloak — избыточен для класса (NFR-11); cookie закрывает XSS-кражу токена |
| ADR-10 | **Один docker compose + офлайн-бандл** (`docker save` + `models/` + сиды); **`docker compose` — основной путь, `make` — удобство для Linux** | установка «руками» по инструкции; k8s | «Упаковка строго по ТЗ», иначе «не смогли оценить» (Q18); Windows 10/11 и Ubuntu — оба через Docker; у экспертов на Windows `make` нет |
| ADR-11 *(18.09, уточнено 19.09)* | **`worker` без HTTP, в одном Python-пакете с `api`**: физически одна папка `apps/api/` с пакетом `app/` — `app/api/` (роуты), `app/core/` (конфиг, БД, модели, безопасность, аудит, адаптер `evalcore`), `app/worker/` (jobs, планировщик, провайдеры, генераторы, судья, промпты), `app/seed/` (загрузчик данных), `app/tools/` (export_openapi и пр.); один `pyproject.toml`, один Dockerfile, два контейнера (`python -m app.api` / `python -m app.worker`); отдельной `apps/worker/` **нет**. Единственный канал `api → worker` — таблица `jobs`; **планировщик карточек — в worker**; `api` — один процесс с WS-хабом в памяти | (а) `ai` как отдельный FastAPI-сервис + очередь (v0.1); (б) Celery/Redis | в v0.1 было два канала (HTTP и jobs) для одного и того же — лишний контракт; планировщик в `api` создаёт дубли при репликах; один пакет = общие ORM-модели, один `evalcore`, один Alembic, ноль внутренних контрактов; изоляция ресурсов и рестарт сохраняются на уровне compose |
| ADR-12 *(18.09)* | **Три слоя ИИ: правила → эмбеддинги (`rubert-tiny2`, ONNX) → LLM (опция)**; эмбеддинги всегда, LLM только вне горячего пути и на модели ≤ 4B по умолчанию | (а) правила + LLM-судья (v0.1); (б) только правила; (в) LLM на всё | LLM на CPU ≈ 30 с на текст → час на занятие из 23 АРМ, отчёт «сразу после занятия» невозможен; эмбеддинги дают честный «нейросетевой анализ» (ТЗ §5) за миллисекунды, офлайн, объяснимо («близость 0,82»); LLM остаётся как бонус и для генерации |
| ADR-13 *(18.09)* | **`AI_PROVIDER=off` по умолчанию + предгенерированные пакеты сценариев в поставке** (`data/packs/`, сделаны LLM заранее и провалидированы) | LLM обязательна для первого запуска | эксперт запускает `docker compose up` и сразу видит «ИИ-сценарии», не скачивая модель на 2–5 ГБ; кнопка «Сгенерировать» работает, если он включил профиль `llm`; демо не зависит от железа проверяющего |
| ADR-14 *(18.09)* | **IRT-1PL вместо Elo + журнал прогнозов `predictions` + график «прогноз vs факт»** (калибровка, Brier) | Elo без журнала (v0.1); ML-регрессия | ТЗ §17 проверяет «сравнение реальных данных и прогнозных значений» — нужен записанный прогноз ДО события; IRT принципиальнее Elo (тот — её частный случай), формулы воспроизводимы через CLI (ТЗ §16 «проверка расчётов») |
| ADR-15 *(18.09)* | **TLS — функциональная необходимость: локальный CA в `deploy/certs/`, сертификат устанавливается на каждый АРМ**; в поставке — скрипты установки для Windows/Ubuntu | self-signed «как есть»; HTTP в классе | `getUserMedia`/`MediaRecorder` доступны только в secure context (HTTPS или `localhost`); на `http://10.0.x.x` запись доклада не работает; без доверенного CA браузеры на 23 АРМ будут ругаться на каждый вход |
| ADR-16 *(18.09)* | **`client_ts` + `server_ts` в каждом событии, оффсет часов клиента измеряется при WS-handshake; `delivered_at` у карточки; оценка времени — по скорректированному `client_ts`, при аномалии — флаг в `evidence`** | только серверное время (v0.1) | NFR-7 требует буферизацию до 30 с; событие `open`, доехавшее с реплеем через 25 с, с серверным временем даёт несправедливые «реакция 40 с»; норматив 30 с — главный критерий, его честность критична |

---

### ADR-17 (20.09): переход от mock к постоянному API по задачам

T-007 вводит `API_MODE=database` и реализует только auth/users/settings/health.
Остальные зарегистрированные методы возвращают 501 до T-008…T-010; mock остаётся
доступным для независимой разработки frontend/softphone/evalcore.
Экспорт OpenAPI строится из FastAPI/Pydantic для реализованных методов; оставшиеся
операции сохраняют spec-first схемы. Тесты проверяют равенство paths/components с draft.
Это позволяет расширять работающую реализацию без удаления интерфейсов команды.
Альтернатива — объявить весь draft фактической схемой — скрыла бы отсутствие реализации.

Изменения общего контракта: `Health.mode` дополнен `database`, ошибки хранилища — 503;
nullable-схемы Pydantic
эквивалентны прежним type-массивам. В БД добавлены auth_sessions для отзыва JWT между
процессами и seed_artifacts для исходных данных. Публичных endpoints не добавлено.
Argon2id выполняется вне event loop; мутация и аудит фиксируются одной транзакцией.
Триггеры PostgreSQL обеспечивают неизменность журналов и однократное заполнение факта прогноза.

## 10. Нефункциональные требования → как обеспечены

| NFR (PRD §7) | Реализация | Проверка |
|---|---|---|
| NFR-1 локальность | все образы/модели/справочники в бандле; `AI_PROVIDER=cloud` выключен; egress-правило в compose (`internal: true` для `ai`, `llm`) | тест запуска с отключённой сетью |
| NFR-2/3 железо | `llm` ограничен `cpus: 4`, `mem: 12g`; `api`/`web` — <1 ГБ; клиент — обычный браузер | замер на i7/32 ГБ |
| NFR-4 нагрузка | stateless `api`, uvicorn workers = 2–4, WS до 100 соединений; LLM не на горячем пути | locust: 25 клиентов, сценарий занятия, p95 UI < 2 с |
| NFR-5 отклик ИИ | rules-оценка < 100 мс; LLM-часть в очереди с индикацией «оценка формируется» | метрики в `/admin/health` |
| NFR-6 голос | пре-рендер → задержка = воспроизведение файла | — |
| NFR-7 устойчивость | клиентский буфер событий (IndexedDB) с реплеем при реконнекте; идемпотентность по `client_event_id`; WS auto-reconnect; `restart: unless-stopped` | e2e: отключить сеть на 20 с |
| NFR-8 БД | PostgreSQL 16; batch-вставка событий | — |
| NFR-9 ОС/браузеры | Docker Desktop (Win) / Docker Engine (Ubuntu); e2e в Chromium + Firefox; проверка в Яндекс.Браузере вручную | CI |
| NFR-10 форматы | JSON сценарии/логи/профили, XML `config/app.xml` (АРМ, службы, нормативы по умолчанию), CSV отчёты, SQL, WAV/MP3 записи, PDF опц. | — |
| NFR-11 простота | правила + веса в UI; промпты — текстовые файлы; один compose | — |
| NFR-12 масштабируемость | §8 | — |
| NFR-14 нормативка | ПДн только в локальной БД, минимум полей; открытый код | — |

Безопасность/админ (FR-7): RBAC-зависимости FastAPI на каждом роуте; `audit_log` middleware для
всех мутаций; `/admin/health` (состояние контейнеров, очередь, БД, место на диске); журналы —
JSON в stdout + volume, ротация ≥ 6 мес.; бэкап-контейнер; `scripts/restore.sh`.

---

## 11. Структура репозитория (монорепо)

```
OneOneTwoInTouch/
├── apps/
│   ├── web/                 # SPA (React+TS+Vite): src/{arm,teacher,admin,shared,api-client}
│   │                        #   зоны: arm/** и teacher/{studio,reports}, admin — Qwots;
│   │                        #   arm/softphone, teacher/{live,replay} — Brikkerdev; shared — капитан
│   └── api/                 # один Python-пакет `app/` (капитан, ADR-11), один образ, два контейнера:
│       └── app/
│           ├── api/         #   роуты: auth, users, services, scenarios, packs, sessions, cards, calls,
│           │                #   evaluations, predictions, overrides, reports, settings, admin, realtime
│           ├── core/        #   config, db, models, security (JWT+CSRF), audit, evalcore_adapter
│           ├── worker/      #   main, scheduler, jobs/, generators/, judge/, providers/{llm,embeddings,tts,stt}, prompts/
│           ├── seed/        #   `python -m app.seed` — загрузчик data/ в БД (argon2 для демо-учёток)
│           └── tools/       #   export_openapi и пр.; tests/ — рядом с кодом (apps/api/tests/)
├── packages/
│   └── evalcore/            # чистый Python (Verwelius): criteria/, scoring.py, adaptive.py (IRT, predict,
│                            #   calibration), difficulty.py, address.py, text.py, clock.py, classifier.py,
│                            #   scenario/ (конструктор + эталон), insights.py, __main__.py (CLI), tests/, README.md
├── contracts/               # openapi.draft.yaml, ws-events.md, jobs.md, scenario.schema.json, card.schema.json,
│                            #   ui_spec_arm.md, db_schema.md
├── deploy/                  # docker-compose.yml, nginx/, certs/ (локальный CA + установка на АРМ), mock/ (prism),
│                            #   config/app.xml, .env.example, bundle.sh, restore.sh, README.md
├── data/                    # артефакты данных (Data Engineer → загружает `app.seed`): classifier.json, streets.csv.gz,
│                            #   golden_scenarios/, packs/, templates/, voices/ (+ README с лицензиями), phonebook.json,
│                            #   seed/demo_users.json, seed/workstations.json, seed/settings.json; models/ (не в git)
├── scripts/                 # свой uv-проект (зависит от evalcore, БД не трогает): build_classifier.py, fetch_streets.py,
│                            #   render_voices.py (piper-tts==1.2.0), gen_packs.py → пишут файлы в data/; archive_milestone.sh
├── intro/                   # комната-вход (Qwots) → раздаётся nginx на /, только для обучаемых
├── qa/                      # e2e (playwright), visual/ (скриншоты-эталоны), load/ (locust), smoke/
├── docs/, requirements/, architecture/
├── docs/submission/         # сдача: documentation/ (Tech Writer: documentation.md, images/, libraries.csv, build.sh —
│                            #   pandoc → docx, LibreOffice → pdf), presentation/ и video/ (Ваня), README_checklist.md (Ваня)
└── Makefile                 # удобство для Linux; основной путь — docker compose (ADR-10)
```

---

## 12. План по этапам (дедлайн 29.09) — v0.2, подробно в `mvp_plan.md`

| Этап | Срок | Кто | Результат |
|---|---|---|---|
| **D1 Контракты и каркас** | 19.09 | капитан через пайплайн `agents/` + Claude Code | `contracts/*`, каркас монорепо и `web`, мок API, сиды, локальный CA; kickoff команды вечером |
| **D2–D4 Параллель по зонам** | 20–22.09 | все пятеро | **Интеграция-1 (22.09):** демо-скрипт на заглушках, e2e зелёный |
| **D5–D7 Полные функции** | 23–25.09 | все | LLM-провайдер и нарратив, судья, эмбеддинги, STT, студия, отчёты с графиками, реплей, «прогноз vs факт», пиксельная копия. **Интеграция-2 (25.09):** прогон «глазами эксперта», freeze фич |
| **D8–D9 Hardening** | 26–27.09 | капитан + все | офлайн-бандл, чистая Windows/Ubuntu, locust 25, обрыв сети 30 с, документация по ТЗ §13. **Интеграция-3 (27.09):** freeze кода |
| **D10–D11 Сдача** | 28–29.09 | Презентер + капитан | видео ≤ 5 мин, презентация, публичная демка, сдача; 29.09 — буфер |

---

## 13. Риски

| Риск | Уровень | Митигация |
|---|---|---|
| LLM на CPU слишком медленный/слабый по-русски | высокий | замер 3 кандидатов в M1; предгенерация; режим `off` даёт рабочий продукт без LLM; grammar-вывод против мусора |
| Пиксельная копия АРМ съест время | средний | только экраны из `docs/screenshots/`; токены и сетка снимаются один раз; не рисовать то, чего нет на скриншотах (Q8) |
| Не хватит эталонов (билетов нет) | средний | `data/golden_scenarios/` — 30 ручных сценариев по классификатору как регрессия для оценщика; импорт билетов — отдельный генератор, добавляется без переделок |
| Справочник улиц: лицензия/объём | низкий | ГАР — открытые госданные; OSM — ODbL с указанием источника; хранить только Москву (~4–5 тыс. улиц) |
| Демо «отваливается» при 10 одновременно | высокий | LLM вне горячего пути; locust в M4; лимиты ресурсов контейнеров; `restart` политики |
| Windows у проверяющих | средний | Docker Desktop + WSL2 в инструкции; бандл проверить на чистой Windows |
| Параллельная разработка ломает контракты | средний | контракты в `contracts/` под code review; моки `api` для `web` с M1; `evalcore` — только через README-интерфейс |

---

## 14. Трассировка PRD → компоненты

| PRD | Компонент(ы) |
|---|---|
| S1–S2, FR-1.1–1.3, 1.5 (АРМ, карточка, статусы, параллельные) | web/arm, api/cards, api/realtime, `card.schema.json` |
| S3, FR-2.* (телефония, TTS) | web/arm/softphone, api/calls, ai/providers/tts, data/voices |
| S4, FR-7.* (роли, RBAC, аудит, бэкап, TLS) | api/auth, api/admin, audit middleware, backup, nginx |
| S5, FR-5.* (пульт, live, вердикты, адаптивность) | web/teacher, api/sessions, api/realtime, evalcore/adaptive |
| S6, FR-3.* (сценарии, генерация, предпросмотр, вес) | ai/generators, web/teacher/studio, api/scenarios, evalcore/difficulty, `scenario.schema.json` |
| S7, FR-4.* (оценка, веса, объяснимость, фидбэк) | evalcore/criteria + scoring, ai/judge, api/evaluations + overrides |
| S8 (уровни + вес 1–10) | scenarios.level/weight, evalcore/difficulty, evalcore/adaptive |
| S9 (жизненный цикл) | api/cards (state machine), card_events |
| S10, NFR-1..5 (локально, CPU, нагрузка) | compose, `AI_PROVIDER`, jobs, пре-рендер |
| S11, NFR-12 (несколько ДДС, масштабируемость) | services + routing_rules, §8 |
| S12 (копия интерфейса) | web/arm, токены со скриншотов |
| FR-1.4 (таймеры, красное поле) | web/arm timers, settings normatives |
| FR-1.6–1.7 (подсказки, справочная база) | web/arm/hints (по уровню), web/shared/help (PDF/DOCX из data/) |
| FR-6.* (отчёты, CSV) | api/reports, web/teacher/reports (ECharts) |
| ТЗ §13, §18 (сдача) | deploy/bundle.sh, docs (M4) |

---

## 15. Открытые вопросы

1. Модель LLM по умолчанию — по результатам замера на CPU (D5, `docs/llm_benchmark.md`; кандидаты §7). Дефолт — ≤ 4B.
2. ~~Источник справочника улиц~~ — решено: OSM для MVP; ОМК УМ с data.mos.ru — если капитан скачает после регистрации (слить).
3. ~~Нужен ли `intro/` преподавателю/админу~~ — решено 18.09: комната **только для обучаемых**, преподаватель/админ — прямые ссылки `/teacher`, `/admin`; справочник телефонов служб — на столе в комнате и в софтфоне. Детали — `extra_features.md` §1.
4. ~~Запись доклада в софтфоне~~ — решено 18.09: уровни A + B в MVP, **C (STT + рубрика доклада) принят в план** после интеграции-1 (`mvp_plan.md` §5.7).
5. ~~«Сформированные обучающимися карточки» (ТЗ §10)~~ — решено: не в хакатоне (точка A вне скоупа по Q&A), `origin=trainee` остаётся в схеме (`extra_features.md` 3.6).
6. ~~Ник 5-го участника~~ — Ваня (Презентер), вписан в `mvp_plan.md` §3.
7. Номера телефонов служб (3 цифры): взять как в реальной АТС заказчика, когда придёт документация по IP-телефонии; до тех пор — `101/102/103/104` и `2xx` для остальных ДДС.
