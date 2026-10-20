# Проверка вдвоём: геймплей ДДС и голос из банка

Ветка `feature/dds-gameplay` (форк brikkerdev), 17.10.2026. В ней весь план
`scripts/ralph/gameplay/prd.json`: GP-01…GP-28 и TC-01…TC-08. Эталон поведения —
`docs/dds_gameplay.md`, прошлая сверка без Docker — `docs/dds_gameplay_check.md`.

GP-28 добавила голос из банка. Реплики бригад в сценариях звучат записями
`data/voices/bank-v1` (ElevenLabs, уже «по телефону»). Окно телефона играет из банка
ответы бригады и дежурных служб. Переспрос вводной и отказ бригады — тоже фразы банка.

## Стенд с нуля

```
git pull
colima start --memory 8          # или Docker Desktop
scripts/stand/up.sh --project arm112-check --ports 47080:47443 --stt local
scripts/stand/check.sh --project arm112-check
```

`--stt local` включает распознавание речи на стенде, без него голосовой путь отвечает
`503 stt_off`. Адрес — `https://127.0.0.1:47443/app/login`. Сертификат —
`scripts/stand/ca.sh --project arm112-check`. Учётные записи: `admin`, `teacher`,
`trainee01`…`trainee05`, пароль `demo-local`. Сброс:
`scripts/stand/down.sh --project arm112-check --reset --yes`.

## Автоматика (делает агент)

```
uv run pytest apps/api                      # нужна тестовая база, DATABASE_URL_TEST
cd apps/web && npm run lint && npm run typecheck && npx vitest run && npm run build
python3 scripts/voices/bank/bank.py check   # ок: 2184 фраз
uv run --package arm112-scripts python qa/smoke/dds_walk.py \
    --api https://127.0.0.1:47443/api --ca <ca.crt> --password demo-local --wav --out walk.json
E2E_BASE_URL=https://127.0.0.1:47443 E2E_DATABASE=1 \
    node node_modules/@playwright/test/cli.js test -c qa/playwright.config.ts --workers=1 \
    qa/e2e/brigade-audio.spec.ts qa/e2e/brigade-incoming.spec.ts qa/e2e/brigade-missed-hold.spec.ts \
    qa/e2e/dds-phone.spec.ts qa/e2e/dds-push-to-talk.spec.ts qa/e2e/heard-status.spec.ts \
    qa/e2e/urgency.spec.ts qa/e2e/live-shift.spec.ts qa/e2e/comment-offline.spec.ts \
    qa/e2e/login-accounts.spec.ts qa/e2e/practice-scenarios.spec.ts qa/e2e/practice-outcome.spec.ts
```

`dds_walk.py` с `--wav` должен получить на WAV вводной 200, а не 503. Облачный цикл
ни разу не гонял e2e на Docker-стенде: там прокси закрывал образы. Это первый такой прогон.

`gates.sh` в большом наборе изменений молча пропускает блоки Python и web: `has()` с
`pipefail` и `grep -q` падает на SIGPIPE. Поэтому команды выше запускаются руками.

## Маршрут (делает человек)

Преподаватель (`teacher`) выдаёт сценарий и начинает занятие. Обучаемый проходит его
голосом, второй раз — по частям. Сценарии и что должно прозвучать:

| Сценарий | Голос бригады | Выезд | Прибытие | Дальше |
| --- | --- | --- | --- | --- |
| smoke-apartment-101-1 | Феликс | 101.responding.any.6 «Принял, выдвигаемся двумя машинами» | 101.arrived.smoke.2 | этаж, скорая дважды, молчание, тревога |
| traffic-blocked-102-2 | Артём | 102.responding.any.5 | 102.arrived.traffic.7 | 102.refused.traffic.1; ловушка повтора адреса без записи |
| unwell-street-103-2 | Ольга | 103.responding.any.1 «Приняла, выезжаем» | 103.arrived.heart.1 | подъезд, 103.completed.heart.6 |
| gas-entrance-104-2 | Алексей | 104.responding.any.3 | 104.arrived.gas_flat.1 | эвакуация, 104.completed.gas_flat.2 |
| not-ours-pipe-104-2 | Алексей | 104.responding.any.2 | — | 104.refused.any.1 |
| animal-shaft-gkh-1 | Кирилл | GKH.responding.any.3 | GKH.arrived.animal.1 | дверь, GKH.working.animal.1 |

Текст каждой фразы — в `data/voices/bank-v1/manifest.json` по id. Дежурные служб при
звонке: 101 — Соколов (Василий), 102 — Медведев (Максим), 103 — Ковалёва (Маруся),
104 — Белова (Елена), прочие должностные лица — Алан. Голоса —
`scripts/voices/casting/voices.json`.

Отдельно стоит позвонить бригаде до «Принята»: должен прозвучать отказ голосом службы.
И дать вводную без адреса: бригада переспросит фразой из банка, а не текстом сервера.

## Чек-лист на слух

- Голос совпадает со службой и персонажем из таблицы, мужской и женский род не путаются.
- Звук телефонный (узкая полоса, подложка улицы или офиса), без двойного «телефонного» фильтра.
- Субтитр совпадает с тем, что прозвучало.
- Пауза до следующего доклада бригады не дольше 40 с.
- Номер регистрации, названный дежурным, совпадает с комментарием в карточке.
- Теги подачи вроде `[shouting]` не произносятся.

## Если звука нет

- Доклад бригады: `GET /api/cards/<id>/training`, у сообщения поля `audio`, `state`,
  `failure_reason`. `playback_error` — браузер не сыграл файл.
- Реплики в разговоре: вкладка Network, запросы `assets/*.ogg`. Записей нет — значит,
  текст реплики не совпал с банком (`apps/web/src/arm/softphone/bankPhrases.json`).
- Сервер: `docker compose -p arm112-check logs api worker`, журнал карточки —
  `GET /api/cards/<id>/events`.

## Что заведомо не сделано

- Ловушка повтора адреса в traffic-blocked-102-2 идёт без записи: в реплике адрес
  карточки, его в банке нет.
- В e2e нет отдельной проверки, что реплика дежурного 102 играет файлом bank-v1. Её
  закрывает маршрут выше; e2e — после проверки.
