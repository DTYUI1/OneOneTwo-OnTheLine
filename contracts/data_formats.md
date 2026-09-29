# Форматы артефактов D1

Все данные в репозитории синтетические либо из предоставленного классификатора. JSON UTF-8.
Паролей и password_hash в `data/seed/demo_users.json` нет; mock берёт `DEMO_PASSWORD` из env.

| Путь | Содержание / пример |
|---|---|
| `data/classifier.json` | `{version, source, incident_types: IncidentType[], routing_rules: RoutingRule[], services: Service[]}`; с 25.09 `version=046_24`, у `condition` обязательный `trigger` (схема `storage.schema.json#/$defs/Classifier`) |
| `data/phonebook.json` | `Service[]` из OpenAPI; 6 служб, уникальные 3-значные номера |
| `data/templates/*.json` | один Scenario по scenario.schema.json |
| `data/golden_scenarios/*.json` | `{id, description, scenario, current, events, calls, settings, expected}` |
| `data/packs/*.json` | `{id, title, status, origin, scenario_ids}`; статусы draft/approved/retired |
| `data/seed/demo_users.json` | User[]; admin, teacher, trainee01..05 |
| `data/seed/workstations.json` | `{id: int, number: int}[]`, 1..23 |
| `data/seed/settings.json` | Settings из OpenAPI, нормативы 30/180, семь весов |
| `data/voices/manifest.json` | `{version, status, phrases: string[], profiles: {id, files, status}[]}` |

`services.category`: fire/police/medical/gas/utilities/lift. `[ASSUMPTION]` GKH=105,
MOSLIFT=106 — учебные внутренние номера, не реальные телефоны экстренных служб.

`routing_rules.condition` = `{kind: 'classifier_column', column: 14, label: '…'}`.
Каждая колонка исходного CSV сохраняется отдельно вместе с текстом условия. Пусто и «нет
реагирования» не создают правило. Не объединять все условия в безусловный список служб!
Интерпретатор условий по признакам сценария — T-026. Парсер сохраняет 1281 уникальный тип,
не включает строки заголовков групп. `main_service_code` сохраняет исходные MCHS/Police/…;
соответствия: MCHS→101, Police→102, AMBULANCE→103, MOSGAZ→104, GKH→GKH, MOSLIFT→MOSLIFT.

Golden: события — CardEvent с дополнительными `server_ts`, `clock_offset_ms`;
звонок — `{id, service_id, phone_ext, started_at, answered_at, ended_at, transcript}`.
`expected = {criteria: {criterion_key: score}, total, tolerance}`, score/total 0..1.
Проверка: `abs(actual-expected) <= tolerance`. Уровни 1..4 и осложнения заданы явно;
значения ожидаемых оценок — контрольные примеры, проверка алгоритмов станет T-006.

Голоса: `files` содержит `{phrase_id: 'listen'|'accepted', path, sha256, duration_ms}`.
Пока `status=pending`, файл не существует и клиент не должен его запрашивать.
Происхождение, модель и лицензия фиксируются в `data/voices/README.md`; отсутствие голоса
должно оставлять доступным набор/завершение звонка (T-014).

Улицы: `streets.csv.gz` с колонками `name,okrug,district,source`, UTF-8, gzip mtime=0.
Это отдельный справочник для T-021; исходные адреса golden не считаются полным справочником Москвы.

## Загрузка T-007

`python -m app.seed` загружает данные одной транзакцией после Alembic 0001.
Повторный запуск вставляет только отсутствующие записи: существующие пароли, нормативы,
пользователи и отредактированные сценарии сохраняются. Синхронизация изменений исходных
файлов с уже работающей БД — отдельная операция, seed её не имитирует.
Параллельные seed сериализуются advisory lock; routing_rules и улицы имеют стабильные UUIDv5
из исходных записей. Требование UUIDv4 относится к новым HTTP-ресурсам.

**[ASSUMPTION T-007]** template traffic и golden case-01 используют один UUID при разных
весах. Для строки scenarios и стартового пакета приоритет имеет golden. Оба исходника
сохранены без изменений в seed_artifacts. Остальные golden не создают учебные события,
звонки и оценки: эти действия должны появляться при реальном прохождении.

В поставке D1 `streets.csv.gz` отсутствует, voices имеет `status=pending`. Seed загружает
манифест, сообщает об отсутствии улиц/аудио, не объявляет эти данные готовыми. Если справочник
улиц добавлен, его строки валидируются и загружаются идемпотентно.
