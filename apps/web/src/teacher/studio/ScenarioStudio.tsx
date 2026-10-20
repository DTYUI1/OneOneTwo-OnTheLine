// Студия сценариев (D-01): список с источником и статусом, создание, правка,
// копия и архив. Редактирование — формой, без ручного JSON.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, csrfToken } from "../../shared/api";
import {
  ORIGIN_LABELS,
  STATUS_LABELS,
  copyForm,
  emptyForm,
  formFromScenario,
  scenarioServiceIds,
  type Scenario,
  type ScenarioForm,
} from "./studioModel";
import { ScenarioEditor } from "./ScenarioEditor";
import { PacksPanel } from "./PacksPanel";
import {
  STUDIO_KEY,
  studioSectionKey,
  draftKey,
  readJSON,
  removeKey,
  writeJSON,
} from "../persist";
import kit from "../console/Console.module.css";
import { SortHeading } from "./SortHeading";
import {
  NEWEST_FIRST,
  sortedRows,
  creationTime,
  creationDate,
  type SortState,
} from "./sorting";
import type { StudioSection } from "./sections";
import styles from "./Studio.module.css";

/** Восьмизначный номер карточки, как в реестре ДДС; учебные начинаются с 9. */
function newNumber(): string {
  return "9" + String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0");
}

export function ScenarioStudio({
  filter = "active",
}: {
  filter?: StudioSection;
}) {
  const queries = useQueryClient();
  const [sort, setSort] = useState<SortState>(NEWEST_FIRST);
  const storageKey = studioSectionKey(filter);
  const [savedEditor] = useState(() => {
    type SavedEditor = { id: string; isNew: boolean; section?: StudioSection };
    const stored = readJSON<SavedEditor>(storageKey);
    if (stored) return stored;
    const legacy = readJSON<SavedEditor>(STUDIO_KEY);
    return legacy?.id && (legacy.section ?? "active") === filter
      ? legacy
      : null;
  });
  const [restoring, setRestoring] = useState(Boolean(savedEditor));
  const [editing, setEditing] = useState<{
    form: ScenarioForm;
    isNew: boolean;
  } | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [pendingId, setPendingId] = useState("");

  const scenarios = useQuery({
    queryKey: ["scenarios"],
    queryFn: async () => {
      const { data, error } = await api.GET("/scenarios");
      if (!data) throw new Error(error?.message ?? "Сценарии недоступны.");
      return data;
    },
  });
  const services = useQuery({
    queryKey: ["services"],
    queryFn: async () => {
      const { data } = await api.GET("/services");
      return data ?? [];
    },
  });
  const serviceName = (id: string) =>
    (services.data ?? []).find((service) => service.id === id)?.name ?? id;

  const open = async (id: string) => {
    setError("");
    // Правим свежую версию, а не строку списка: иначе 409 на первом же сохранении.
    const { data, error } = await api.GET("/scenarios/{id}", {
      params: { path: { id } },
    });
    if (!data) return setError(error?.message ?? "Сценарий не загрузился.");
    setEditing({ form: formFromScenario(data), isNew: false });
  };

  const retire = async (scenario: Scenario) => {
    setPendingId(scenario.id);
    setError("");
    const { data, error } = await api.POST("/scenarios/{id}/retire", {
      params: {
        path: { id: scenario.id },
        header: { "X-CSRF-Token": csrfToken() },
      },
    });
    setPendingId("");
    if (!data) return setError(error?.message ?? "Не удалось архивировать.");
    setNotice(
      `«${scenario.card.incident_class}» в архиве. История назначений сохранена.`,
    );
    await queries.invalidateQueries({ queryKey: ["scenarios"] });
  };

  // После перезагрузки открываем тот же сценарий: сохранённый — свежей версией
  // с сервера, новый — из черновика правок.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const restore = async () => {
      try {
        if (!savedEditor) return;
        if (savedEditor.isNew) {
          const draft = readJSON<{ form: ScenarioForm }>(
            draftKey(savedEditor.id),
          );
          if (draft) setEditing({ form: draft.form, isNew: true });
          else removeKey(storageKey);
        } else await open(savedEditor.id);
      } catch {
        setError(
          "Не удалось открыть сценарий. Попробуйте выбрать его из списка.",
        );
      } finally {
        setRestoring(false);
      }
    };
    void restore();
    // Восстановление выполняется один раз при открытии студии.
  }, []);
  useEffect(() => {
    if (editing)
      writeJSON(storageKey, {
        id: editing.form.id,
        isNew: editing.isNew,
        section: filter,
      });
  }, [editing, filter, storageKey]);
  useEffect(() => {
    writeJSON(STUDIO_KEY, { section: filter });
  }, [filter]);

  if (restoring)
    return (
      <p className={kit.placeholder} role="status">
        Открываем сценарий…
      </p>
    );

  if (editing)
    return (
      <div data-help="teacher-editor">
        <ScenarioEditor
          key={editing.form.id}
          initial={editing.form}
          isNew={editing.isNew}
          services={services.data ?? []}
          newId={() => crypto.randomUUID()}
          newNumber={newNumber}
          onClose={(message) => {
            removeKey(storageKey);
            setEditing(null);
            setNotice(message ?? "");
            window.scrollTo({ top: 0 });
          }}
        />
      </div>
    );

  const all = scenarios.data ?? [];
  const filtered = all.filter((scenario) =>
    filter === "active"
      ? scenario.status !== "retired"
      : scenario.status === filter,
  );

  const shown = sortedRows(filtered, sort, (scenario, key) => {
    switch (key) {
      case "number":
        return scenario.card.number;
      case "service":
        return (
          scenarioServiceIds(scenario).map(serviceName).join(", ") ||
          serviceName(scenario.target_service_id)
        );
      case "title":
        return scenario.card.incident_class;
      case "level":
        return scenario.level;
      case "weight":
        return scenario.weight;
      case "status":
        return STATUS_LABELS[scenario.status];
      case "origin":
        return ORIGIN_LABELS[scenario.origin];
      default:
        return creationTime(scenario.created_at);
    }
  });

  return (
    <section
      className={kit.view}
      aria-labelledby="studio-title"
      data-help="teacher-studio"
    >
      <header className={kit.titleBar}>
        <div>
          <h2 id="studio-title">Студия сценариев</h2>
          <span className={kit.status_draft}>{all.length}</span>
        </div>
        <div className={kit.titleActions}>
          <button
            type="button"
            className={kit.primary}
            onClick={() =>
              setEditing({
                form: emptyForm(crypto.randomUUID(), newNumber()),
                isNew: true,
              })
            }
          >
            + Новый сценарий
          </button>
        </div>
      </header>

      {filter === "packs" ? (
        <PacksPanel
          services={services.data ?? []}
          onOpenScenario={(id) => void open(id)}
        />
      ) : (
        <div className={kit.tabBody}>
          {notice && (
            <p role="status" className={kit.message}>
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" className={kit.message}>
              {error}
            </p>
          )}
          {scenarios.isPending && (
            <p className={kit.placeholder}>Загружаем сценарии…</p>
          )}
          {scenarios.isError && (
            <p role="alert" className={kit.placeholder}>
              Сценарии не загрузились.{" "}
              <button
                type="button"
                className={kit.plain}
                onClick={() => void scenarios.refetch()}
              >
                Повторить
              </button>
            </p>
          )}
          {scenarios.data && shown.length === 0 && (
            <p className={kit.placeholder}>В этой группе сценариев нет.</p>
          )}
          {shown.length > 0 && (
            <div className={kit.panel}>
              <div className={styles.wide}>
                <table className={kit.table}>
                  <thead>
                    <tr>
                      <SortHeading
                        label="Номер"
                        field="number"
                        sort={sort}
                        onSort={setSort}
                      />
                      <SortHeading
                        label="Служба"
                        field="service"
                        sort={sort}
                        onSort={setSort}
                      />
                      <SortHeading
                        label="Происшествие"
                        field="title"
                        sort={sort}
                        onSort={setSort}
                      />
                      <SortHeading
                        label="Ур."
                        field="level"
                        sort={sort}
                        onSort={setSort}
                      />
                      <SortHeading
                        label="Вес"
                        field="weight"
                        sort={sort}
                        onSort={setSort}
                      />
                      <SortHeading
                        label="Статус"
                        field="status"
                        sort={sort}
                        onSort={setSort}
                      />
                      <SortHeading
                        label="Источник"
                        field="origin"
                        sort={sort}
                        onSort={setSort}
                      />
                      <SortHeading
                        label="Дата"
                        field="created_at"
                        sort={sort}
                        onSort={setSort}
                      />
                      <th aria-label="Действия" />
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((scenario) => (
                      <tr key={scenario.id}>
                        <td>{scenario.card.number}</td>
                        <td>
                          <span className={kit.chip}>
                            {scenarioServiceIds(scenario)
                              .map(serviceName)
                              .join(", ") ||
                              serviceName(scenario.target_service_id) ||
                              "не указана"}
                          </span>
                        </td>
                        <td>
                          <button
                            type="button"
                            className={styles.titleLink}
                            onClick={() => void open(scenario.id)}
                          >
                            {scenario.card.incident_class || "без типа"}
                          </button>
                          <div className={kit.muted}>
                            {scenario.card.description}
                          </div>
                        </td>
                        <td>{scenario.level}</td>
                        <td>{scenario.weight}</td>
                        <td>
                          <span className={styles[`st_${scenario.status}`]}>
                            {STATUS_LABELS[scenario.status]}
                          </span>{" "}
                          <span className={kit.muted}>v{scenario.version}</span>
                        </td>
                        <td>{ORIGIN_LABELS[scenario.origin]}</td>
                        <td>{creationDate(scenario.created_at)}</td>
                        <td className={kit.rowActions}>
                          <button
                            type="button"
                            className={kit.plain}
                            onClick={() => void open(scenario.id)}
                          >
                            {scenario.status === "retired"
                              ? "Открыть"
                              : "Изменить"}
                          </button>
                          <button
                            type="button"
                            className={kit.plain}
                            onClick={() =>
                              setEditing({
                                form: copyForm(
                                  {
                                    ...formFromScenario(scenario),
                                    number: newNumber(),
                                  },
                                  crypto.randomUUID(),
                                ),
                                isNew: true,
                              })
                            }
                          >
                            Копия
                          </button>
                          {scenario.status !== "retired" && (
                            <button
                              type="button"
                              className={kit.plain}
                              disabled={Boolean(pendingId)}
                              onClick={() => void retire(scenario)}
                            >
                              В архив
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
