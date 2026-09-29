// Пакеты (D-01, п. 3): генерация через job с прогрессом «N из M» и повтором, разбор
// пакета, утверждение пригодных сценариев одной операцией пакета (C-05) с request_id.
// Неполный эталон отметить нельзя — он не выдаётся.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, csrfToken } from "../../shared/api";
import {
  JOB_LABELS,
  newPack,
  randomSeed,
  readiness,
  summarizePack,
  type Job,
  type Pack,
} from "./packModel";
import { ORIGIN_LABELS, STATUS_LABELS, type Service } from "./studioModel";
import kit from "../console/Console.module.css";
import styles from "./Studio.module.css";

export function PacksPanel({
  services,
  onOpenScenario,
}: {
  services: Service[];
  onOpenScenario: (id: string) => void;
}) {
  const queries = useQueryClient();
  // Выключенной службе сервер пакет не соберёт (422) — не предлагаем.
  const active = services.filter((service) => service.is_active);
  const [params, setParams] = useState({
    service_id: active[0]?.id ?? "",
    level: 1,
    count: 5,
    seed: randomSeed(),
  });
  const [jobId, setJobId] = useState<string | null>(null);
  const handled = useRef<string | null>(null);
  const [packsBefore, setPacksBefore] = useState<Pack[]>([]);
  const [openPackId, setOpenPackId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const packs = useQuery({
    queryKey: ["packs"],
    queryFn: async () => {
      const { data, error } = await api.GET("/packs");
      if (!data) throw new Error(error?.message ?? "Пакеты недоступны.");
      return data;
    },
  });
  const serviceName = (id: string) =>
    services.find((service) => service.id === id)?.name ?? id;

  // Задание опрашивает сам TanStack Query и останавливается на done/failed.
  // Свой setTimeout в эффекте здесь не годится: часы в шапке перерисовывают
  // страницу каждую секунду, и таймер сбрасывался бы раньше, чем сработает.
  const jobQuery = useQuery({
    queryKey: ["job-progress", jobId],
    enabled: Boolean(jobId),
    queryFn: async () => {
      const { data, error } = await api.GET("/jobs/{id}/progress", {
        params: { path: { id: jobId! } },
      });
      if (!data)
        throw new Error(error?.message ?? "Статус генерации не читается.");
      return data;
    },
    refetchInterval: (query) =>
      query.state.data &&
      ["done", "failed"].includes(query.state.data.job.status)
        ? false
        : 1500,
  });
  const progress = jobQuery.data ?? null;
  const job: Job | null = progress?.job ?? null;

  useEffect(() => {
    if (!jobId || job?.status !== "done" || handled.current === jobId) return;
    handled.current = jobId;
    void (async () => {
      const fresh = await queries.fetchQuery({
        queryKey: ["packs"],
        queryFn: async () => (await api.GET("/packs")).data ?? [],
        staleTime: 0,
      });
      await queries.invalidateQueries({ queryKey: ["scenarios"] });
      // Пакет задания называет сервер; без него — новый пакет в списке.
      const made = progress?.pack_id ?? newPack(packsBefore, fresh)?.id;
      if (made) setOpenPackId(made);
    })();
  }, [job?.status, jobId, packsBefore, progress?.pack_id, queries]);

  const generate = async () => {
    setError("");
    setPacksBefore(packs.data ?? []);
    const { data, error } = await api.POST("/packs/generate", {
      params: { header: { "X-CSRF-Token": csrfToken() } },
      body: params,
    });
    if (!data) return setError(error?.message ?? "Генерация не запустилась.");
    setJobId(data.id);
  };

  const busy = job?.status === "pending" || job?.status === "running";

  return (
    <div className={kit.tabBody}>
      <div className={kit.panel}>
        <h3 className={kit.panelTitle}>Сгенерировать пакет</h3>
        <div className={kit.actions}>
          <label className={kit.field}>
            Служба
            <select
              value={params.service_id}
              onChange={(event) =>
                setParams({ ...params, service_id: event.target.value })
              }
            >
              {active.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name}
                </option>
              ))}
            </select>
          </label>
          <label className={kit.field}>
            Уровень
            <select
              value={params.level}
              onChange={(event) =>
                setParams({ ...params, level: Number(event.target.value) })
              }
            >
              {[1, 2, 3, 4].map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </label>
          <label className={kit.field}>
            Сценариев, 1…100
            <input
              type="number"
              min={1}
              max={100}
              value={params.count}
              className={kit.number}
              onChange={(event) =>
                setParams({ ...params, count: Number(event.target.value) })
              }
            />
          </label>
          <label className={kit.field}>
            Исходное число
            <input
              type="number"
              value={params.seed}
              className={kit.number}
              onChange={(event) =>
                setParams({ ...params, seed: Number(event.target.value) })
              }
            />
          </label>
          <button
            type="button"
            className={kit.primary}
            disabled={
              busy ||
              !params.service_id ||
              params.count < 1 ||
              params.count > 100
            }
            onClick={() => void generate()}
          >
            {busy ? "Генерируется…" : "Сгенерировать"}
          </button>
        </div>
        <p className={kit.hint}>
          То же исходное число с теми же параметрами даёт тот же пакет.
          Сгенерированные сценарии приходят черновиками — выдать их можно только
          после утверждения.
        </p>
        {job && (
          <p
            className={job.status === "failed" ? kit.problems : kit.hint}
            role={job.status === "failed" ? "alert" : "status"}
          >
            Генерация: {JOB_LABELS[job.status]}
            {progress &&
              (job.status === "done"
                ? ` · сценариев: ${progress.completed}`
                : job.status === "failed"
                  ? ` · успели ${progress.completed} из ${progress.total}`
                  : ` · ${progress.completed} из ${progress.total}`)}
            {job.error && ` — ${job.error}`}
            {job.status === "failed" && (
              <>
                {" "}
                <button
                  type="button"
                  className={kit.plain}
                  onClick={() => void generate()}
                >
                  Повторить
                </button>
              </>
            )}
          </p>
        )}
        {progress && busy && (
          <progress
            className={styles.grow}
            max={progress.total}
            value={progress.completed}
            aria-label="Прогресс генерации"
          />
        )}
        {progress?.warnings.map((warning) => (
          <p key={warning} className={kit.hint}>
            {warning}
          </p>
        ))}
        {jobQuery.isError && (
          <p role="alert">Статус генерации не читается — проверьте связь.</p>
        )}
        {error && <p role="alert">{error}</p>}
      </div>

      {openPackId ? (
        <PackView
          packId={openPackId}
          pack={
            (packs.data ?? []).find((item) => item.id === openPackId) ?? null
          }
          serviceName={serviceName}
          onBack={() => setOpenPackId(null)}
          onOpenScenario={onOpenScenario}
        />
      ) : (
        <div className={kit.panel}>
          <h3 className={kit.panelTitle}>Пакеты · {packs.data?.length ?? 0}</h3>
          {packs.isPending && <p>Загружаем пакеты…</p>}
          {packs.data?.length === 0 && <p>Пакетов пока нет.</p>}
          {(packs.data ?? []).length > 0 && (
            <table className={kit.table}>
              <thead>
                <tr>
                  <th>Пакет</th>
                  <th>Сценариев</th>
                  <th>Статус</th>
                  <th>Источник</th>
                </tr>
              </thead>
              <tbody>
                {[...(packs.data ?? [])].reverse().map((pack) => (
                  <tr key={pack.id}>
                    <td>
                      <button
                        type="button"
                        className={styles.titleLink}
                        onClick={() => setOpenPackId(pack.id)}
                      >
                        {pack.title}
                      </button>
                    </td>
                    <td>{pack.scenario_ids.length}</td>
                    <td>{STATUS_LABELS[pack.status]}</td>
                    <td>{ORIGIN_LABELS[pack.origin]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function PackView({
  packId,
  pack,
  serviceName,
  onBack,
  onOpenScenario,
}: {
  packId: string;
  pack: Pack | null;
  serviceName: (id: string) => string;
  onBack: () => void;
  onOpenScenario: (id: string) => void;
}) {
  const queries = useQueryClient();
  const scenarios = useQuery({
    queryKey: ["scenarios"],
    queryFn: async () => {
      const { data } = await api.GET("/scenarios");
      return data ?? [];
    },
  });
  const [checked, setChecked] = useState<string[]>([]);
  const [results, setResults] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState("");
  // Повтор того же утверждения (обрыв связи) идёт с тем же request_id — сервер
  // не утвердит дважды; другой набор сценариев — новый request_id.
  const attempt = useRef<{ key: string; id: string } | null>(null);

  const members = (pack?.scenario_ids ?? [])
    .map((id) => scenarios.data?.find((item) => item.id === id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const summary = summarizePack(members);
  const readyIds = members
    .filter((item) => readiness(item).ready)
    .map((item) => item.id);

  // Отмеченные сценарии утверждаются одной операцией пакета: сервер проверяет
  // версии и эталоны и утверждает всё или ничего.
  const approve = async () => {
    const scenarios = members
      .filter((item) => checked.includes(item.id))
      .map((item) => ({ scenario_id: item.id, version: item.version }));
    if (scenarios.length === 0) return;
    const key = JSON.stringify(scenarios);
    if (attempt.current?.key !== key)
      attempt.current = { key, id: crypto.randomUUID() };
    setRunning(true);
    setFailure("");
    const { data, error } = await api.POST("/packs/{id}/approve", {
      params: { path: { id: packId }, header: { "X-CSRF-Token": csrfToken() } },
      body: { request_id: attempt.current.id, scenarios },
    });
    setRunning(false);
    if (!data) {
      setFailure(
        `${error?.message ?? "Пакет не утверждён."} Ни один сценарий не утверждён — исправьте и повторите.`,
      );
      await queries.invalidateQueries({ queryKey: ["scenarios"] });
      return;
    }
    attempt.current = null;
    setResults(
      Object.fromEntries(
        data.approved.map((item) => [
          item.scenario_id,
          `утверждён, версия ${item.version}`,
        ]),
      ),
    );
    setChecked([]);
    await queries.invalidateQueries({ queryKey: ["scenarios"] });
    await queries.invalidateQueries({ queryKey: ["packs"] });
  };

  if (!pack)
    return (
      <p className={kit.placeholder}>
        Пакет {packId.slice(0, 8)} не найден.{" "}
        <button type="button" className={kit.plain} onClick={onBack}>
          К пакетам
        </button>
      </p>
    );

  return (
    <div className={kit.panel}>
      <div className={kit.actions}>
        <h3 className={kit.panelTitle}>{pack.title}</h3>
        <button type="button" className={kit.plain} onClick={onBack}>
          К пакетам
        </button>
      </div>
      <p className={kit.hint}>
        всего {summary.total} · утверждено {summary.approved} · готовы к
        утверждению {summary.ready} · требуют правки {summary.blocked}
      </p>
      <table className={kit.table}>
        <thead>
          <tr>
            <th aria-label="Выбор" className={kit.pick} />
            <th>Происшествие</th>
            <th>Служба</th>
            <th>Ур.</th>
            <th>Статус</th>
            <th>Готовность</th>
          </tr>
        </thead>
        <tbody>
          {members.map((scenario) => {
            const verdict = readiness(scenario);
            return (
              <tr key={scenario.id}>
                <td className={kit.pick}>
                  <input
                    type="checkbox"
                    aria-label={`Отметить: ${scenario.card.incident_class}`}
                    disabled={!verdict.ready || running}
                    checked={checked.includes(scenario.id)}
                    onChange={(event) =>
                      setChecked(
                        event.target.checked
                          ? [...checked, scenario.id]
                          : checked.filter((id) => id !== scenario.id),
                      )
                    }
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className={styles.titleLink}
                    onClick={() => onOpenScenario(scenario.id)}
                  >
                    {scenario.card.incident_class}
                  </button>
                  {results[scenario.id] && (
                    <div className={kit.muted}>{results[scenario.id]}</div>
                  )}
                </td>
                <td>{serviceName(scenario.target_service_id)}</td>
                <td>{scenario.level}</td>
                <td>
                  <span className={styles[`st_${scenario.status}`]}>
                    {STATUS_LABELS[scenario.status]}
                  </span>
                </td>
                <td>
                  {scenario.status === "approved" ? (
                    <span className={kit.muted}>можно выдавать</span>
                  ) : verdict.ready ? (
                    "готов"
                  ) : (
                    <ul className={kit.problems}>
                      {verdict.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className={kit.actions}>
        <button
          type="button"
          className={kit.plain}
          disabled={readyIds.length === 0 || running}
          onClick={() => setChecked(readyIds)}
        >
          Отметить все готовые ({readyIds.length})
        </button>
        <button
          type="button"
          className={kit.primary}
          disabled={checked.length === 0 || running}
          onClick={() => void approve()}
        >
          {running ? "Утверждаем…" : `Утвердить отмеченные (${checked.length})`}
        </button>
      </div>
      {failure && (
        <p className={kit.problems} role="alert">
          {failure}
        </p>
      )}
      <p className={kit.hint}>
        Отмеченные сценарии утверждаются вместе: сервер проверяет версию и
        эталон каждого и утверждает все или ни одного. Сценарий, требующий
        правки, откройте в редакторе.
      </p>
    </div>
  );
}
