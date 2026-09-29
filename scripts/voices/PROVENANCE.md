# Происхождение реплик служб

Что здесь: откуда взяты голоса, под какой лицензией, какие файлы получились и как их
пересобрать. Требование `data/voices/README.md`: лицензия движка не заменяет лицензию
голоса, поэтому лицензии ниже — у **датасетов голосов**, а не у Piper.

## Как пересобрать

```sh
scripts/voices/generate.sh          # синтез в контейнере, ~4 минуты на холодном кэше
python3 scripts/voices/manifest.py  # собрать manifest.json по схеме
```

Доклад бригады о завершении работ (VO-01, этап `completion`) собирается отдельно —
этап ещё не подключён к seed, поэтому его записи не должны попасть в `manifest.json`:

```sh
scripts/voices/generate.sh --stage completion
python3 scripts/voices/completion_manifest.py  # собрать brigade/completion.pending.json
```

Отказ бригады, не направленной на происшествие (28.09, этап `refusal`): «Мы заняты на
другом происшествии» и «Нам этот вызов не назначен», обе фразы каждым из четырёх голосов
(тексты — `brigade_texts.py`, `REFUSAL_PHRASES`). Это не фраза Q14: в `VoiceManifest`
её нет, файлы лежат в `data/voices/refusal/<голос>/`, копия для телефона — в
`apps/web/src/arm/softphone/refusal/`, карта — `refusalAssets.ts`:

```sh
scripts/voices/generate.sh --stage refusal
python3 scripts/voices/refusal_manifest.py  # сверить SHA-256, собрать refusalAssets.ts
```

Рецепт закреплён: образ `python:3.11-slim-bookworm`, `piper-tts==1.2.0` (версия из
`data/voices/README.md`), модели скачиваются с проверкой md5 — подменённая модель дала бы
другой голос в готовых файлах и осталась бы незамеченной.

Синтез идёт в Docker потому, что у `piper-phonemize` нет колеса под macOS ARM; в
Linux-контейнере он ставится и на aarch64, и на x86_64, поэтому рецепт одинаков у всех.

Модели (~63 МБ каждая) кэшируются в `scripts/voices/.cache` и в репозиторий не попадают:
в runtime ни модели, ни синтезатор не нужны — приложению нужны только готовые файлы.

## Движок

| | |
| --- | --- |
| Синтезатор | Piper, `piper-tts==1.2.0` (PyPI) |
| Источник моделей | `huggingface.co/rhasspy/piper-voices`, ветка `main` |
| Лицензия движка | MIT |
| Формат | WAV, 22 050 Гц, моно |

## Голоса и их лицензии

В наборе Piper для русского языка есть ровно четыре голоса — других нет.

| Профиль | Голос | Пол | Датасет | **Лицензия датасета** |
| --- | --- | --- | --- | --- |
| `voice-1` | `ru_RU-denis-medium` | мужской | OHF-Voice/voice-datasets | **CC0** |
| `voice-2` | `ru_RU-irina-medium` | женский | RHVoice (голос Irina) | **CC BY-SA 4.0** (см. ниже) |
| `voice-3` | `ru_RU-dmitri-medium` | мужской | OHF-Voice/voice-datasets | **CC0** |
| `voice-4` | `ru_RU-ruslan-medium` | мужской | ruslan-corpus | **CC BY-NC-SA 4.0** |

Лицензии взяты из MODEL_CARD каждого голоса в репозитории `rhasspy/piper-voices`.

### Решение капитана (25.09.2026): оставить все четыре голоса

Проверено по первоисточникам 25.09.2026 (юридической экспертизой это не является):

- **irina.** В MODEL_CARD Piper лицензия — Unknown, источник — RHVoice. Голос Irina
  исторически входил в состав RHVoice; в перечне ограничений RHVoice (`licenses/README`
  выпуска 1.0.0, `LICENSE.md` выпуска 1.2.4) ограничения названы только для голосов
  RHVoice Lab (CC BY-NC-ND 4.0), Talgat, Natia и Letícia-F123 — Irina среди них нет.
  Дистрибутив Arch Linux распространяет пакет `rhvoice-voice-irina` под **CC-BY-SA-4.0**
  и при этом голоса RHVoice Lab помечает CC-BY-NC-ND-4.0, то есть различает источники.
  Отдельного файла лицензии в репозитории `RHVoice/irina-rus` нет. Используем как
  CC BY-SA 4.0: указание авторства (RHVoice, голос Irina) и та же лицензия для
  производного аудио; коммерческое использование этой лицензией не запрещено.
- **ruslan.** Корпус RUSLAN — CC BY-NC-SA 4.0 (MODEL_CARD Piper, ruslan-corpus.github.io).
  Учебное некоммерческое использование разрешено при указании авторства корпуса;
  производное аудио `voices/ruslan/*` распространяется под той же лицензией
  CC BY-NC-SA 4.0 отдельно от кода. **Перед любым коммерческим использованием
  профиль `voice-4` заменяется на `dmitri` или `denis`** — одна строка в
  `scripts/voices/manifest.py`.

Итог: для учебного тренажёра есть мужские и женский голоса, требование FR-2.2 выполнено.
Ограничения записаны в сопроводительной документации (раздел 4).

Атрибуция для поставки:

- Piper (MIT), модели `rhasspy/piper-voices`;
- RHVoice, голос Irina — CC BY-SA 4.0;
- RUSLAN corpus (Gabdrakhmanov, Garaev, Razinkov, 2019) — CC BY-NC-SA 4.0;
- датасеты denis и dmitri (OHF-Voice/voice-datasets) — CC0.

## Файлы

Хеши и длительности — из `data/voices/manifest.json`, он же источник для бэкенда
(`PrerenderedTTS` читает `path` относительно `data/`).

| Профиль | Фраза | Файл | Длительность, мс | sha256 |
| --- | --- | --- | --- | --- |
| `voice-1` | `accepted` | `voices/denis/accepted.wav` | 2218 | `c4f7e4375b280594…` |
| `voice-1` | `listen` | `voices/denis/listen.wav` | 906 | `851f02fcee0209f6…` |
| `voice-2` | `accepted` | `voices/irina/accepted.wav` | 2694 | `389f37c333c8fe2b…` |
| `voice-2` | `listen` | `voices/irina/listen.wav` | 1149 | `838708da7ecd92f7…` |
| `voice-3` | `accepted` | `voices/dmitri/accepted.wav` | 1939 | `d5b0eac348d01a26…` |
| `voice-3` | `listen` | `voices/dmitri/listen.wav` | 824 | `d68a8d0fffe71723…` |
| `voice-4` | `accepted` | `voices/ruslan/accepted.wav` | 2241 | `daeaa0aca04e49ba…` |
| `voice-4` | `listen` | `voices/ruslan/listen.wav` | 1207 | `3e674c485d264d37…` |

Тексты фраз заданы ответом кейсодержателя Q14: «Слушаю вас» и
«Я вас понял, информация принята».

## Протокол прослушивания

Приёмка B-01 требует ручного прослушивания: автотест не слышит.

| | |
| --- | --- |
| Дата | 24.09.2026 |
| Кто слушал | Brikkerdev (владелец зоны) |
| Где | стенд `apps/web/src/arm/softphone/stand.html`, номера 101…106 |
| Что проверялось | все четыре профиля, обе фразы, разборчивость на гарнитуре |
| Результат | **принято**: голоса различимы, реплики разборчивы |

Лицензионный состав голосов предъявлен владельцу зоны вместе с таблицей выше;
решение оставить все четыре профиля принято осознанно и подтверждено капитаном
25.09.2026 (раздел «Решение капитана» выше).

## Заявители модуля «Оператор 112» (этап 2, 29.09)

Реплики заявителей всех сценариев `data/operator/scenarios/` — те же голоса и лицензии, что
выше: девушка, пожилая и ребёнок — `irina`, мужчина — `ruslan`. Пожилой голос — `irina`
ниже и медленнее, детский — выше на треть (сдвиг тона `ffmpeg`, `asetrate`); паника и
истерика — быстрее, выше, громче. Всё — телефонная полоса 300–3400 Гц, Opus 20 кбит/с,
16 кГц. Фон в трубке (подъезд с датчиком дыма, улица, квартира, лифтовая шахта) —
синтез `ffmpeg` (`anoisesrc`, `sine`), сторонних записей нет. Раскладка и профили —
`operator_texts.py`.

```sh
scripts/voices/operator_generate.sh              # синтез в контейнере, ~5 минут
python3 scripts/voices/operator_manifest.py      # копия в apps/web/src/operator/voices/, voiceAssets.ts
```

Файлы — `data/voices/operator/`, отчёт с текстами и SHA-256 — `operator-report.json`.
Правку текста реплики без пересборки ловит `test_voice_lines_are_voiced_with_current_texts`.

Этап 3 (29.09): добавлены ответы на новые вопросы карт (номер для связи, имя, ориентир,
подъезд, этаж, код), на повтор адреса (`confirm.*`) и на лишние вопросы шагов
(`distractor.*`) — тот же синтез, те же голоса и лицензии. Итого 186 реплик (было 108) и
4 фона, около 1,6 МБ; раскладку с сервером сверяет `test_voice_layout_matches_server_lines`.
