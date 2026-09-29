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
  draftKey,
  readJSON,
  removeKey,
  writeJSON,
} from "../persist";
import kit from "../console/Console.module.css";
import { onTabListKey } from "../tabKeys";
import styles from "./Studio.module.css";

type Filter = "active" | Scenario["status"] | "packs";
const FILTERS: [Filter, string][] = [
  ["active", "рабочие"],
  ["draft", "черновики"],
  ["approved", "утверждённые"],
  ["retired", "архив"],
  ["packs", "пакеты"],
];

/** Восьмизначный номер карточки, как в реестре ДДС; учебные начинаются с 9. */
function newNumber(): string {
  return "9" + String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0");
}

export function ScenarioStudio() {
  const queries = useQueryClient();
  const [filter, setFilter] = useState<Filter>("active");
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
  const packs = useQuery({
    queryKey: ["packs"],
    queryFn: async () => {
      const { data } = await api.GET("/packs");
      return data ?? [];
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
    const stored = readJSON<{ id: string; isNew: boolean }>(STUDIO_KEY);
    if (!stored) return;
    if (stored.isNew) {
      const draft = readJSON<{ form: ScenarioForm }>(draftKey(stored.id));
      if (draft) setEditing({ form: draft.form, isNew: true });
      else removeKey(STUDIO_KEY);
    } else void open(stored.id);
    // Восстановление выполняется один раз при открытии студии.
  }, []);
  useEffect(() => {
    if (editing)
      writeJSON(STUDIO_KEY, { id: editing.form.id, isNew: editing.isNew });
  }, [editing]);

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
            removeKey(STUDIO_KEY);
            setEditing(null);
            setNotice(message ?? "");
            window.scrollTo({ top: 0 });
          }}
        />
      </div>
    );

  const all = scenarios.data ?? [];
  const shown = all.filter((scenario) =>
    filter === "active"
      ? scenario.status !== "retired"
      : scenario.status === filter,
  );

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
      <div
        className={kit.tabs}
        role="tablist"
        aria-label="Статус сценариев"
        onKeyDown={onTabListKey}
      >
        {FILTERS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={filter === key}
            className={kit.tab}
            onClick={() => setFilter(key)}
          >
            {label}
            <span className={kit.tabCount}>
              {key === "packs"
                ? (packs.data?.length ?? 0)
                : key === "active"
                  ? all.filter((item) => item.status !== "retired").length
                  : all.filter((item) => item.status === key).length}
            </span>
          </button>
        ))}
      </div>

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
                      <th>Номер</th>
                      <th>Служба</th>
                      <th>Происшествие</th>
                      <th>Ур.</th>
                      <th>Вес</th>
                      <th>Статус</th>
                      <th>Источник</th>
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
