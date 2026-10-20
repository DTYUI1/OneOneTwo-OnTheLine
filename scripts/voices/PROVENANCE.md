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

## Живая бригада (DT-10, 08.10)

Реплики событий бригады в тренировке «Задымление в квартире», служба 101, полный цикл
(`data/practice/smoke-apartment.json`, блок `live`), и два изменённых доклада того же
варианта (`arrival-1`, `works-1`): `data/voices/practice/smoke-apartment/101/event-*.ogg`,
записи в `data/voices/practice/manifest.json`. Голос — голос службы 101, как у докладов.

**Отступление от рецепта.** Docker в среде разработки не был запущен, поэтому файлы собраны
офлайн тем же `practice_synth.py` на хосте: `piper-tts==1.8.0` из локального кэша uv
(а не закреплённый 1.2.0 в контейнере), модели — из уже скачанного кэша
`scripts/voices/.cache` с проверкой md5, без загрузки. Модель голоса та же; звук может
слегка отличаться от сборки 1.2.0. Пересобрать по закреплённому рецепту: удалить эти
файлы и их записи из `manifest.json`, затем `scripts/voices/practice_generate.sh` — готовые
файлы с тем же текстом он не трогает, поэтому без удаления ничего не пересоберётся.
Реплики сюжета связки (`data/link112/plots`) озвучены отдельно 11.10 — раздел ниже.

11.10: тем же способом (piper-tts 1.8.0 из кэша uv, модели из `scripts/voices/.cache`
основного клона только читались) добавлены три реплики события «повтор адреса с ошибкой»:
`event-readback.ogg`, `event-readback-met.ogg`, `event-readback-wrong-replace.ogg` (подмена
доклада о прибытии общая для веток «не так» и «не сделал» — озвучена один раз).

13.10 (DT-06, вводные преподавателя): тревога расчёта «только вводной» в «Задымлении в
квартире», служба 101 — `event-alarm.ogg`, `event-alarm-met.ogg`, `event-alarm-late.ogg`.
Не синтезировались: это побайтные копии одноимённых файлов связки
`data/voices/link112/fire_apartment_smoke/101/` (тот же голос `denis`, тот же текст, тот же
SHA-256 — раздел «Связка 112 → ДДС» ниже, рецепт piper-tts 1.2.0).

## Связка 112 → ДДС (DT-10, 11.10)

Доклады и реплики бригады связки озвучены по закреплённому рецепту: `link112_generate.sh` →
`link112_synth.py` (образ `python:3.11-slim-bookworm`, `piper-tts==1.2.0`, модель из кэша
`scripts/voices/.cache` с проверкой md5). Зачем: реплика без звука засчитывается
предъявленной только по кнопке «Принял» — диспетчер, прочитавший тревогу и сразу
позвонивший в 103, получал «позже срока» (проверка DT-12). Озвученная реплика
проигрывается и засчитывается сама.

Сюжет `fire_apartment_smoke`, служба 101 — голос службы `voice-1` (`denis`, CC0), как у
докладов тренировки. Файлы — `data/voices/link112/fire_apartment_smoke/101/`, записи с
текстами и SHA-256 — `data/voices/link112/manifest.json`:

| Файл | Что |
| --- | --- |
| `departure.ogg` | доклад о выезде |
| `arrival-1.ogg`, `works-1.ogg`, `completion-1.ogg` | полный цикл |
| `arrival-2.ogg`, `outcome-2.ogg` | осложнение (уровень 2) |
| `arrival-fire_apartment_smoke.wrong-street.ogg` | прибытие по ошибочному адресу карточки этой записи |
| `arrival-fire_apartment_smoke.wrong-street-level2.ogg` | то же для записи уровня 2 (12.10, тот же рецепт) |
| `event-alarm.ogg`, `event-alarm-met.ogg`, `event-alarm-late.ogg` | тревога: травмирован боец, ответы |
| `event-alarm-again.ogg` | повторный вопрос про скорую |
| `event-alarm-again-missed-replace.ogg` | подмена доклада о завершении — скорой не было |

Доклад о прибытии не туда несёт адрес из карточки оператора, поэтому он свой у каждой
записи, которая уводит бригаду (`arrival-<запись>.ogg`; запись с верным адресом его не получает). Соответствие путей и текстов seed сверяет
`test_every_link_report_and_live_line_is_voiced_with_matching_text`.
