# Сценарии вне ротации

Решение капитана 29.09 (`docs/operator_112_review/PLAN.md`): в модуле «Оператор 112» четыре
сценария — по одному на персонажа (девушка, взрослый, пожилой, ребёнок). Остальные лежат здесь
и не загружаются ни сервером, ни копией для веба.

- `scenarios/gas_smell_entrance.json`, карта `questionnaires/gas_smell.json` — запах газа в подъезде;
- `scenarios/person_danger_street.json`, карта `questionnaires/person_danger.json` — человек в
  опасности на улице;
- `scenarios/wrong_call.json` — ошибочный звонок (ложный вызов — после хакатона).

Вернуть сценарий: перенести файл (и его карту) обратно в `data/operator/scenarios/` и
`questionnaires/`, дописать поля, которых нет в старой версии — `description_facts` и
`named_address_fields` (`contracts/operator/scenario.schema.json`), — затем пересобрать копию
для веба: `UPDATE_OPERATOR_DATA=1 pnpm test` в `apps/web`.

С этапа 3 (29.09) ещё нужно: у вопросов карты — шаг опроса `step` и вопросы `confirm_address`,
`landmark`, `callback`, `name` (`questionnaire.schema.json`); у сценария — персонаж и реплики
этапа 2, ответы на повтор адреса `address_confirmation`, лишние вопросы шагов `distractors`
(объекты с `step` и `reply`, 3–4 варианта на шаг) и `reference_order`; затем озвучить
(`scripts/voices/operator_generate.sh`, `operator_manifest.py`).
