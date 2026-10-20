import { FieldCaption, FieldHelp } from "../shared/FieldHelp";
// Нормативы и веса критериев — PUT /settings. Действует на новые занятия:
// занятие при создании сохраняет снимок настроек (settings_snapshot).
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, csrfToken } from "../shared/api";
import { HandlingNormativeField } from "../shared/HandlingNormativeField";
import { criterionLabel } from "../teacher/console/model";
import {
  MAX_PARALLEL,
  orderedWeightKeys,
  settingsChanged,
  validateSettings,
  weightValue,
  type Settings,
} from "./adminModel";
import styles from "../teacher/console/Console.module.css";

export function SettingsForm() {
  const queries = useQueryClient();
  const saved = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const { data, error } = await api.GET("/settings");
      if (!data) throw new Error(error?.message ?? "Настройки недоступны.");
      return data;
    },
  });
  const [draft, setDraft] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (saved.data && draft === null) setDraft(saved.data);
  }, [saved.data, draft]);

  const save = useMutation({
    mutationFn: async (value: Settings) => {
      const { data, error } = await api.PUT("/settings", {
        params: { header: { "X-CSRF-Token": csrfToken() } },
        body: value,
      });
      if (!data) throw new Error(error?.message ?? "Настройки не сохранены.");
      return data;
    },
    onSuccess: async (value) => {
      setError("");
      setDraft(value);
      setNotice(
        "Сохранено. Новые значения получат занятия, созданные с этого момента.",
      );
      queries.setQueryData(["settings"], value);
    },
    onError: (cause: Error) => {
      setNotice("");
      setError(cause.message);
    },
  });

  if (saved.isError)
    return (
      <p role="alert" className={styles.placeholder}>
        Настройки недоступны: {saved.error.message}
      </p>
    );

  if (saved.isPending || !draft)
    return <p className={styles.placeholder}>Загружаем настройки…</p>;
  const problems = validateSettings(draft);
  const dirty = saved.data ? settingsChanged(draft, saved.data) : false;
  const set = (patch: Partial<Settings>) => {
    setNotice("");
    setDraft({ ...draft, ...patch });
  };

  return (
    <form
      className={styles.tabBody}
      onSubmit={(event) => {
        event.preventDefault();
        if (problems.length === 0) save.mutate(draft);
      }}
    >
      <p className={styles.warning}>
        Это значения по умолчанию для класса: их получат занятия, созданные
        после сохранения, а преподаватель может изменить их для своего занятия.
        Для уже созданных занятий настройки останутся прежними.
      </p>

      <SettingsFields
        value={draft}
        onChange={(patch) => set(patch)}
        weightHint="Вес — насколько критерий влияет на итог; 0 исключает критерий. Максимальный балл ограничивает оценку карточки при критической ошибке. Штраф за доклад вариантом уменьшает балл за содержание доклада по сравнению с голосом: 0 % — без снижения, 100 % — содержание не засчитывается."
      />

      {problems.length > 0 && (
        <ul className={styles.problems} role="status">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      <div className={styles.actions}>
        <button
          type="submit"
          className={styles.primary}
          disabled={!dirty || problems.length > 0 || save.isPending}
        >
          Сохранить
        </button>
        <button
          type="button"
          className={styles.plain}
          disabled={!dirty || save.isPending}
          onClick={() => {
            setDraft(saved.data ?? draft);
            setNotice("");
            setError("");
          }}
        >
          Отменить изменения
        </button>
      </div>
    </form>
  );
}

/**
 * Поля нормативов и оценки. Админ задаёт ими значения по умолчанию для класса
 * (PUT /settings), преподаватель — снимок своего занятия (settings_snapshot):
 * тайминг и критерии успешности настраивает преподаватель (ТЗ, роль «Преподаватель»).
 */
export function SettingsFields({
  value,
  onChange,
  weightHint,
}: {
  value: Settings;
  onChange: (patch: Partial<Settings>) => void;
  weightHint: string;
}) {
  return (
    <>
      <div className={styles.panel}>
        <h3 className={styles.panelTitle}>Нормативы</h3>
        <div className={styles.actions}>
          <label className={styles.field}>
            <FieldCaption
              label="Реакция, с"
              help="Допустимое время от получения карточки до принятия или отказа, в секундах."
            />
            <input
              aria-label="Реакция, с"
              type="number"
              min={1}
              value={value.reaction_normative_s}
              className={styles.number}
              onChange={(event) =>
                onChange({ reaction_normative_s: Number(event.target.value) })
              }
            />
          </label>
          <HandlingNormativeField
            value={value.handling_normative_s}
            onChange={(seconds) => onChange({ handling_normative_s: seconds })}
          />
          <label className={styles.field}>
            <FieldCaption
              label="Параллельных карточек"
              help="Сколько карточек может быть в работе одновременно. Если уровень обучаемого меньше, действует ограничение по уровню."
            />
            <input
              aria-label="Параллельных карточек"
              type="number"
              min={1}
              max={MAX_PARALLEL}
              value={value.parallel_cards}
              className={styles.number}
              onChange={(event) =>
                onChange({ parallel_cards: Number(event.target.value) })
              }
            />
          </label>
          <label className={styles.field}>
            Подсказки новичку
            <select
              value={value.hints_level}
              onChange={(event) =>
                onChange({ hints_level: Number(event.target.value) })
              }
            >
              <option value={0}>выключены</option>
              <option value={1}>включены</option>
            </select>
          </label>
          <label className={styles.field}>
            Подсказки орфографии
            <input
              type="checkbox"
              className={styles.checkbox}
              checked={value.spelling_hints ?? false}
              onChange={(event) =>
                onChange({ spelling_hints: event.target.checked })
              }
            />
          </label>
          <label className={styles.field}>
            Доклад только голосом
            <input
              type="checkbox"
              className={styles.checkbox}
              checked={value.voice_only ?? false}
              onChange={(event) =>
                onChange({ voice_only: event.target.checked })
              }
            />
          </label>
        </div>
        <p className={styles.hint}>
          Реакция — от направления карточки до статуса «Принята» или «Не
          принята». Учебная отработка — активное время от открытия до
          завершения, без подтверждённого ожидания. По умолчанию реакция — 30
          секунд, отработка — 3:00. Число одновременных карточек ограничено
          также уровнем обучаемого: действует меньшее значение. Подсказки
          орфографии подчёркивают ошибки в комментарии и предлагают исправления.
          Включайте их в учебных занятиях: в контрольном грамотность входит в
          оценку. Доклад только голосом убирает варианты ответа из окна
          разговора со службой — для контрольного занятия.
        </p>
      </div>

      <div className={styles.panel}>
        <h3 className={styles.panelTitle}>Оценка</h3>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Критерий</th>
              <th>
                Вес{" "}
                <FieldHelp label="Вес критерия">
                  Насколько этот критерий влияет на итоговую оценку по сравнению
                  с другими. 0 — не учитывать критерий.
                </FieldHelp>
              </th>
            </tr>
          </thead>
          <tbody>
            {orderedWeightKeys(value.weights).map((key) => (
              <tr key={key}>
                <td>{criterionLabel(key)}</td>
                <td>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    aria-label={`Вес: ${criterionLabel(key)}`}
                    value={weightValue(value.weights, key) ?? ""}
                    className={styles.number}
                    onChange={(event) =>
                      onChange({
                        weights: {
                          ...value.weights,
                          [key]: Number(event.target.value),
                        },
                      })
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className={styles.actions}>
          <label className={styles.field}>
            <FieldCaption
              label="Максимальный балл при критической ошибке, 0…1"
              help="Оценка не превысит это значение, если допущена критическая ошибка. Например, 0,5 означает не более 50 %."
            />
            <input
              aria-label="Максимальный балл при критической ошибке, 0…1"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={value.critical_cap}
              className={styles.number}
              onChange={(event) =>
                onChange({ critical_cap: Number(event.target.value) })
              }
            />
          </label>
          <label className={styles.field}>
            <FieldCaption
              label="Штраф за доклад вариантом, %"
              help="Насколько снизить балл за содержание доклада, если обучаемый выбрал готовый ответ вместо голосового доклада. 0 % — без снижения."
            />
            <input
              aria-label="Штраф за доклад вариантом, %"
              type="number"
              min={0}
              max={100}
              step={1}
              value={Math.round(
                (1 - (value.report_choice_factor ?? 0.5)) * 100,
              )}
              className={styles.number}
              onChange={(event) =>
                onChange({
                  report_choice_factor:
                    (100 - Number(event.target.value)) / 100,
                })
              }
            />
          </label>
        </div>
        <p className={styles.hint}>{weightHint}</p>
      </div>
    </>
  );
}
