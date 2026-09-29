// Нормативы и веса критериев — PUT /settings. Действует на новые занятия:
// занятие при создании сохраняет снимок настроек (settings_snapshot).
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, csrfToken } from "../shared/api";
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
        Уже созданные и идущие занятия работают по своему снимку настроек.
      </p>

      <SettingsFields
        value={draft}
        onChange={(patch) => set(patch)}
        weightHint="Вес — насколько критерий влияет на итог; 0 исключает критерий. Потолок — выше какого балла карточка не поднимется, если допущена критическая ошибка."
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
            Реакция, с
            <input
              type="number"
              min={1}
              value={value.reaction_normative_s}
              className={styles.number}
              onChange={(event) =>
                onChange({ reaction_normative_s: Number(event.target.value) })
              }
            />
          </label>
          <label className={styles.field}>
            Отработка, с
            <input
              type="number"
              min={1}
              value={value.handling_normative_s}
              className={styles.number}
              onChange={(event) =>
                onChange({ handling_normative_s: Number(event.target.value) })
              }
            />
          </label>
          <label className={styles.field}>
            Параллельных карточек
            <input
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
        </div>
        <p className={styles.hint}>
          Реакция — от направления карточки до статуса «Принята» или «Не
          принята». Учебная отработка — активное время от открытия до
          завершения, без подтверждённого ожидания. По умолчанию нормативы равны
          30 секундам и 3 минутам. Число одновременных карточек ограничено также
          уровнем обучаемого: действует меньшее значение. Подсказки орфографии
          подчёркивают ошибки в комментарии и предлагают исправления. Включайте
          их в учебных занятиях: в контрольном грамотность входит в оценку.
        </p>
      </div>

      <div className={styles.panel}>
        <h3 className={styles.panelTitle}>Оценка</h3>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Критерий</th>
              <th>Вес</th>
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
            Потолок при критической ошибке, 0…1
            <input
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
        </div>
        <p className={styles.hint}>{weightHint}</p>
      </div>
    </>
  );
}
