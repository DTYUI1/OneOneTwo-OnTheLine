# Голосовой ввод вопроса — `GET /api/operator/config`, `POST /api/operator/transcribe`

Модуль «Оператор 112». Кнопка записи вопроса на экране `/operator` (OP-08) — выключаемая
опция поверх общего распознавания речи (`STT_PROVIDER`, `contracts/jobs.md`). Оба эндпоинта
вне `contracts/openapi.draft.yaml` (`include_in_schema=False`), как и остальные эндпоинты
модуля — пока он не получил свой OpenAPI-фрагмент (OP-01).

Доступ: обучаемый, преподаватель, администратор; без входа — 401, без `X-CSRF-Token` — 403
(на `/transcribe`).

## Почему не через очередь задач worker'а

Задача `transcribe` (`contracts/jobs.md`) ключуется по `call_id` из таблицы `calls` —
worker сам находит путь к файлу в БД по этому id. У разговора с заявителем в этом модуле
нет своей строки `calls` (OP-01 отложена, состояние заявителя хранит клиент), поэтому
эндпоинт вызывает `STTProvider.transcribe()` синхронно и напрямую, без очереди: то же
локальное распознавание (`app/worker/providers/stt/local.py`), тот же `STT_PROVIDER`,
без изменений в worker.

## `GET /config`

```json
{ "stt_enabled": true }
```

`stt_enabled` — включено голосовое распознавание (`STT_PROVIDER=local`) или нет
(`off`/`null`). Экран показывает кнопку записи вопроса только когда `true`.

## `POST /transcribe`

Multipart, поле `audio` (WAV/WebM/Ogg, как запись доклада — `MAX_AUDIO_BYTES` в
`arm/softphone/recorder.ts`), не более 10 МиБ. `STT_PROVIDER=off`/`null` — 404.

```json
{ "text": "Где горит?" }
```

Распознанный текст идёт тем же путём, что свободный вопрос оператора (`POST /ask`,
`contracts/operator/dialog.md`, OP-03) — экран сам подставляет его в форму вопроса и
отправляет. Пустая строка — распознавание не удалось; экран это трактует как обычный
пустой ответ (кнопка «спросить» не отправляет пустой вопрос).

## Голос заявителя (этап 2)

Обратное направление — заявитель говорит голосом. Реплики заранее озвучены Piper
(`piper-tts==1.2.0`, без интернета и GPU в работе), сервер только называет файл: в ответе
`POST /ask` поле `reply.voice` = `<scenario_id>/<реплика>` (`contracts/operator/dialog.md`).

- Ключи реплик: `opening`; `<вопрос>.calm`, `<вопрос>.panic`; `hysteria.<n>`; `calming`,
  `calmed`, `order`, `repeat`, `not_understood`, `irrelevant`, `hold`; `pause.<n>`;
  `advice.<ключ>`; `escalation`; этап 3 — `confirm.<ответ>` (повтор адреса: `ok`,
  `wrong_street`, `wrong_details`, `empty`, `panic`) и `distractor.<ключ>` (лишние вопросы
  шагов) — `voice_lines()` в `apps/api/app/operator/caller.py`.
- Голос по персонажу (`persona.kind`): девушка — `irina`; мужчина — `ruslan`; пожилая —
  `irina` ниже и медленнее, с лёгкой дрожью; ребёнок — `irina` выше. Паника — быстрее и выше,
  истерика — ещё быстрее и громче. Всё — телефонная полоса 300–3400 Гц
  (`scripts/voices/operator_texts.py`).
- Фон в трубке (`scenario.background`): подъезд с писком датчика дыма, улица, квартира с
  часами, лифтовая шахта — синтез `ffmpeg`, без сторонних записей, петля 16 с.
- Файлы: `data/voices/operator/<scenario>/<реплика>.ogg`, `background/<фон>.ogg`, отчёт
  `operator-report.json` (тексты, SHA-256). Копия для веба — `apps/web/src/operator/voices/`,
  карта — `voiceAssets.ts` (`CALLER_VOICES`, `BACKGROUNDS`).
- Сборка: `scripts/voices/operator_generate.sh`, затем
  `python3 scripts/voices/operator_manifest.py`. Правка текста реплики без пересборки
  ловится тестом `test_voice_lines_are_voiced_with_current_texts`.
- Нет файла или звук выключен кнопкой «звук» — реплика видна текстом, темп разговора
  держится паузой по длине текста.
