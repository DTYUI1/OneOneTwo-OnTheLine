# evalcore v0.1

Дополнение C-01: [I-TIME](I-TIME.md), [I-EVAL/I-CONTENT](C01_INTERFACES.md).
`timing_contract.py`: dataclasses ввода/результата и Protocol TimingCalculator для V-01.
`iteration_contract.py`: PresentedInformation, SupplementalResult, PredictionContext, CalibrationObservation,
Recommendation и Protocol для V-02/V-03/C-05. Формы также в `c01.schema.json`.
Прежние EvalContext/evaluate/predict не изменены; новые Protocol не вызываются runtime.
Приведение данных и сохранение результата — C-02/C-06, не обязанность evalcore.

Публичные dataclasses: `packages/evalcore/evalcore/models.py`; пояснения и формулы —
`packages/evalcore/README.md`. Изменение сигнатур — `contract:` PR с капитаном.

`evaluate(EvalContext) -> Evaluation` (total 0..1, CriterionResult[] и critical_flags).
`predict(Trainee, scenario: dict[str, Json]) -> Prediction` (вероятности 0..1, время в секундах).
Вход без HTTP/ORM: scenario/current/events/calls/settings/streets/routing_rules/planned_messages.
UUID и времена на границе — строки по JSON-контрактам. Вывод сериализуется `dataclasses.asdict`.
Пример полного входа: `data/golden_scenarios/case-01.json`.

## Доклад → статус (L-01, 27.09)

Аддитивное необязательное поле `PlannedMessage.justifies_state` (`c01.schema.json`):
статус карточки, который обосновывает доклад бригады — выезд → `responding`, прибытие →
`arrived`, работы → `working`, завершение → `completed`, доклад-осложнение → `refused`
(VAR-01, 27.09). Планы без поля валидны как прежде.
`EvalContext.planned_messages` (по умолчанию пусто) — доклады плана версии сценария
`{message_id, justifies_state | null, presented_at | null}`; `presented_at` — первое
подтверждённое `message_presented` выдачи этого сообщения на карточке (C01_INTERFACES,
I-BRIGADE), рендер и скачивание аудио предъявлением не считаются.

`status_flow`: статус, у которого есть доклады-основания и ни один не предъявлен, убирается
и из эталона, и из факта — не требуется и не снижает балл; пояснение называет такие статусы.
Предъявленный доклад без отмеченного статуса снижает балл по прежней формуле LCS. Нет плана
или связей в нём — оценка прежняя.

T-006 начинает с семи критериев. Остальные интерфейсы ADR-14 (update/calibration,
address.match, scenario.build, clock.correct, suggest_weight) закрепляются в отдельных
`contract:` PR перед T-021…T-026; пустые реализации не используются как готовые функции.

## Прогноз занятия: вход C-01 v2

Статус: contract-ready, алгоритм V-03 и адаптер/хранение C-06 пока не реализованы.
Отдельная точка реализации Verwelius — `evalcore/adaptive.py:predict_for_session`:

```python
def predict_for_session(
    trainee: Trainee,
    scenario: dict[str, Json],
    *,
    context: PredictionContext,
) -> Prediction: ...
```

Сигнатура закреплена Protocol `SessionPredictor` в `iteration_contract.py`.
`Prediction` — прежний `evalcore.models.Prediction`; тип Trainee и формат Scenario
не меняются. До V-03 функция не подменяется фиктивным расчётом. Старый
`predict(trainee, scenario)` остаётся отдельной совместимой точкой; scheduler
пока вызывает именно её и использует `worker-irt-fallback-v1` при NotImplementedError.
Новый Protocol не подключён к scheduler и не создаёт HTTP-операцию.

`PredictionContext` — обязательный дополнительный вход:

| Поле | Значение и источник для C-06 |
|---|---|
| `contract_version` | `2`, версия формы входа, не версия модели |
| `snapshot_id` | UUID занятия, как TimingInput/TimingResult.snapshot_id |
| `policy` | Полный сохранённый TimingPolicy этого занятия из C-02/SessionLifecycle.timing_policy |
| `policy.timing_version` | `2`, версия методики времени |
| `policy.reaction_normative_s` | Норматив реакции из этого snapshot |
| `policy.handling_normative_s` | Норматив обработки из этого snapshot; порог прогноза превышения |

Policy целиком переносится из сохранённого снимка, не собирается из текущих `/settings`.
При создании занятия C-02 проверяет совпадение её нормативов с settings_snapshot.
Нормативы конечные и строго положительные, в секундах; 0, отрицательные, boolean,
строки и null не допускаются. NaN/Infinity не являются JSON-числами. Неизвестный
snapshot/policy или версия не дают полноценный вход v2: C-06 не подставляет 30/180,
а явно отмечает недоступность нового прогноза. Legacy-вызов не выдаётся за v2.
Как остальные dataclasses C-01, эти классы не валидируют внешний ввод сами:
на границе используется JSON Schema, в чистый алгоритм поступают проверенные данные.

Смысл `p_timeout = P(handling_s > policy.handling_normative_s)`: равенство нормативу
допустимо. Здесь handling — полное первое open→terminal v2, не lifetime и не
active_handling; подтверждённое ожидание остаётся отдельным показателем по I-TIME.
`Trainee.log_time_mean/variance` описывают распределение времени человека и не
перезаписываются нормативом занятия. Один Trainee и Scenario допускают два контекста
100 и 180 с; норматив изменяет порог p_timeout. Проверку реальных вероятностей
и калибровки выполняет V-03, C-01 проверяет только полноту и форму входа.

## История калибровки и адаптер C-06

CalibrationObservation содержит обязательные, но nullable сведения о времени:

| Поле | Источник для завершённой попытки |
|---|---|
| `snapshot_id` | UUID её занятия; null, если связь неизвестна |
| `handling_s` | TimingResult.handling_s; null при неизвестном интервале |
| `timing_version` | Версия методики этой попытки, 1 или 2 |
| `handling_normative_s` | Норматив из сохранённого snapshot **этой попытки**, не следующего занятия |
| `timing_quality` | TimingResult.quality: verified/estimated/invalid/legacy; null, если качество не сохранено/не установлено |

Для нового v2 C-06 передаёт snapshot_id, handling_normative_s и quality из его
TimingResult, сверенного с сохранённой политикой занятия. estimated-время может
передаваться числом для объяснения, но не как достоверный факт своевременности;
invalid-интервал — null. Измерение 0 допустимо и отличается от null.
Факт своевременности разрешено получать сравнением `handling_s > handling_normative_s`
только при timing_version=2, timing_quality=verified и обоих известных числах.
При estimated/invalid/legacy/null или неизвестном нормативе факт неизвестен,
не false/0; выбор истории для обучения и веса данных явно документирует V-03.

Старая история без сохранённого норматива получает `handling_normative_s=null`,
даже если сегодня в settings стоит 180. Если старый snapshot содержит норматив,
передаётся именно он, но это не делает legacy-время verified. Существующее
`predictions.actual_time_s` измерялось от appeared_at: его нельзя назвать handling_s v2.
Адаптер либо использует доступный результат соответствующей методики, либо
передаёт неизвестный handling_s; старые строки predictions/evaluations не изменяются.
При отсутствии записи качества передаётся null, а не выдуманный verified.

История включает только завершённые прошлые попытки: made_at < completed_at и
completed_at раньше момента нового прогноза/обновления. automatic/effective score
и override_id остаются раздельными; прерванные попытки не превращаются в ноль.
C-06 сохраняет прогноз и его контекст до начала попытки, затем связывает факт с той
же версией snapshot. Необходимое хранение/миграция выполняются в C-06 отдельно.
В этом изменении сохранённые прогнозы и их публичные ответы не расширяются.

Общие примеры в `c01.schema.json`: PredictionContext для 100/180 и
CalibrationObservation для verified/estimated/неизвестной legacy-истории.
Первые примеры продублированы в `examples/c01.json` для потребителей.
