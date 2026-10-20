import { FieldHelp } from "../../shared/FieldHelp";
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api";
import type { components } from "../../api-client/schema";
import styles from "./Studio.module.css";
import kit from "../console/Console.module.css";

export type GenerationTrainee = components["schemas"]["GenerationTrainee"];

function traineeLabel(trainee: GenerationTrainee) {
  return trainee.full_name
    ? `${trainee.full_name} (${trainee.login})`
    : trainee.login;
}

export function GenerationTraineePicker({
  value,
  serviceId,
  disabled,
  onChange,
}: {
  value: GenerationTrainee | null;
  serviceId: string;
  disabled: boolean;
  onChange: (value: GenerationTrainee | null) => void;
}) {
  const inputId = useId();
  const [login, setLogin] = useState("");
  const search = useQuery({
    queryKey: ["generation-trainees", login.trim(), serviceId],
    enabled: Boolean(login.trim() && serviceId) && !value,
    queryFn: async () => {
      const { data, error } = await api.GET("/packs/generation-trainees", {
        params: { query: { login: login.trim(), service_id: serviceId } },
      });
      if (!data)
        throw new Error(error?.message ?? "Поиск обучаемых недоступен.");
      return data;
    },
  });
  return (
    <div>
      <div className={kit.field}>
        <span>
          <label htmlFor={inputId}>Для обучаемого</label>
          <FieldHelp label="Для обучаемого">
            Если выбрать обучаемого, задания будут подобраны с учётом его
            результатов. Без выбора — по заданным службе, уровню и темам.
          </FieldHelp>
        </span>
        <div className={styles.traineeInput}>
          <input
            id={inputId}
            value={login}
            placeholder="Поиск по ФИО или логину"
            disabled={disabled}
            maxLength={100}
            onChange={(event) => {
              setLogin(event.target.value);
              onChange(null);
            }}
          />
          {(value || login) && (
            <button
              type="button"
              className={kit.plain}
              disabled={disabled}
              onClick={() => {
                setLogin("");
                onChange(null);
              }}
            >
              Без обучаемого
            </button>
          )}
        </div>
      </div>
      {value ? (
        <p className={kit.hint}>
          Выбран {traineeLabel(value)}. {value.explanation}{" "}
        </p>
      ) : login.trim() ? (
        <>
          {search.isFetching && <p role="status">Ищем обучаемых…</p>}
          {search.isError && <p role="alert">Поиск обучаемых недоступен.</p>}
          {search.data?.length === 0 && <p>Обучаемые не найдены.</p>}
          <ul
            className={styles.traineeResults}
            aria-label="Найденные обучаемые"
          >
            {search.data?.map((trainee) => (
              <li key={trainee.id}>
                <button
                  type="button"
                  className={kit.plain}
                  disabled={disabled}
                  onClick={() => {
                    setLogin(traineeLabel(trainee));
                    onChange(trainee);
                  }}
                >
                  {traineeLabel(trainee)}
                </button>
              </li>
            ))}
          </ul>
          <p className={kit.hint}>
            Выберите обучаемого из результатов. Пока никто не выбран — задания
            создаются без учёта личных результатов.
          </p>
        </>
      ) : (
        <p className={kit.hint}>
          Без выбора — задания без учёта личных результатов.
        </p>
      )}
    </div>
  );
}
