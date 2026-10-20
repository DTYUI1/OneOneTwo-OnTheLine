import { FieldHelp } from "../../shared/FieldHelp";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api";
import type { components } from "../../api-client/schema";
import styles from "./Console.module.css";
import themes from "./ThemeSelection.module.css";

export type Category = NonNullable<
  components["schemas"]["GenerateInput"]["categories"]
>[number];

export function ThemeSelection({
  value,
  onChange,
  disabled = false,
}: {
  value: Category[];
  onChange: (categories: Category[]) => void;
  disabled?: boolean;
}) {
  const categories = useQuery({
    queryKey: ["generation-categories"],
    queryFn: async () => {
      const { data } = await api.GET("/packs/generation-categories");
      if (!data) throw new Error("Не удалось загрузить темы.");
      return data;
    },
    staleTime: Infinity,
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  });
  return (
    <fieldset className={themes.themes} disabled={disabled}>
      <legend>
        Темы происшествий{" "}
        <FieldHelp label="Темы происшествий">
          Выберите одну или несколько тем. «Все темы» снимает ограничение по
          темам.
        </FieldHelp>
      </legend>
      <p className={themes.explanation}>
        Выберите, какие происшествия включить в задания. Если подходящих сюжетов
        нет, будут использованы все темы службы. Вы увидите предупреждение.
      </p>
      <label className={themes.option}>
        <input
          type="checkbox"
          checked={value.length === 0}
          onChange={() => onChange([])}
        />
        Все темы
      </label>
      {Object.entries(categories.data ?? {}).map(([code, label]) => (
        <label className={themes.option} key={code}>
          <input
            type="checkbox"
            checked={value.includes(code as Category)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...value, code as Category]
                  : value.filter((item) => item !== code),
              )
            }
          />
          {label}
        </label>
      ))}
      {categories.isPending && <p className={styles.hint}>Загрузка тем…</p>}
      {categories.error && (
        <p role="alert">
          {categories.error.message}{" "}
          <button
            type="button"
            className={styles.plain}
            disabled={categories.isFetching}
            onClick={() => void categories.refetch()}
          >
            {categories.isFetching ? "Загрузка тем…" : "Повторить"}
          </button>
        </p>
      )}
    </fieldset>
  );
}
