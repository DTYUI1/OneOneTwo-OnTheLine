// Справка на занятие: преподаватель выбирает справочные материалы (только reference),
// сервер добавляет их к занятию одним запросом с request_id (повтор безопасен),
// назначать можно только до старта. Чтения назначенного у сервера нет — последний
// ответ храним в sessionStorage, чтобы он пережил перезагрузку.
import { useRef, useState } from "react";
import { api, csrfToken } from "../../shared/api";
import { readJSON, writeJSON } from "../persist";
import { useMaterials } from "./MaterialsPanel";
import { assignable, contentUrl, type Material } from "./materialsModel";
import kit from "../console/Console.module.css";

const key = (sessionId: string) => `teacher:session-materials:${sessionId}`;

export function SessionMaterials({
  sessionId,
  draft,
}: {
  sessionId: string;
  draft: boolean;
}) {
  const materials = useMaterials();
  const [checked, setChecked] = useState<string[]>([]);
  const [assigned, setAssigned] = useState<Material[]>(
    () => readJSON<Material[]>(key(sessionId)) ?? [],
  );
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const last = useRef<{ body: string; requestId: string } | null>(null);

  const options = assignable(materials.data ?? []);

  const assign = async () => {
    const chosen = options.filter((item) => checked.includes(item.id));
    if (chosen.length === 0) return;
    const items = chosen.map((item) => ({
      material_id: item.id,
      version: item.version,
    }));
    const body = JSON.stringify(items);
    // Тот же набор — тот же request_id: сервер вернёт прежний ответ и не задвоит.
    const requestId =
      last.current && last.current.body === body
        ? last.current.requestId
        : crypto.randomUUID();
    last.current = { body, requestId };
    setPending(true);
    setError("");
    const { data, error, response } = await api.POST(
      "/sessions/{id}/materials",
      {
        params: {
          path: { id: sessionId },
          header: { "X-CSRF-Token": csrfToken() },
        },
        body: { request_id: requestId, materials: items },
      },
    );
    setPending(false);
    if (!data) {
      setError(
        response.status === 409
          ? (error?.message ??
              "Материалы назначаются только до начала занятия.")
          : (error?.message ?? "Справка не назначена."),
      );
      return;
    }
    const merged = [
      ...assigned.filter((item) => !data.some((next) => next.id === item.id)),
      ...data,
    ];
    setAssigned(merged);
    writeJSON(key(sessionId), merged);
    setChecked([]);
  };

  return (
    <div className={kit.panel}>
      <h3 className={kit.panelTitle}>Справка на занятие</h3>
      {assigned.length > 0 && (
        <ul className={kit.handout} role="status">
          {assigned.map((item) => (
            <li key={`${item.id}-${item.version}`}>
              <a href={contentUrl(item)} target="_blank" rel="noreferrer">
                {item.title}
              </a>{" "}
              · версия {item.version} — видна обучаемым занятия
            </li>
          ))}
        </ul>
      )}
      {!draft ? (
        <p className={kit.hint}>
          Занятие уже идёт: справку назначают до старта.
          {assigned.length === 0 && " На этой странице назначений не было."}
        </p>
      ) : materials.isError ? (
        <p role="alert">{materials.error.message}</p>
      ) : options.length === 0 ? (
        <p className={kit.hint}>
          Справочных материалов нет — загрузите их в разделе «Материалы».
        </p>
      ) : (
        <>
          <ul className={kit.scenarioChecks}>
            {options.map((item) => (
              <li key={item.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={checked.includes(item.id)}
                    onChange={(event) =>
                      setChecked(
                        event.target.checked
                          ? [...checked, item.id]
                          : checked.filter((id) => id !== item.id),
                      )
                    }
                  />
                  {item.title} · версия {item.version}
                </label>
              </li>
            ))}
          </ul>
          <div className={kit.actions}>
            <button
              type="button"
              className={kit.primary}
              disabled={checked.length === 0 || pending}
              onClick={() => void assign()}
            >
              {pending ? "Назначаем…" : `Назначить справку (${checked.length})`}
            </button>
          </div>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
