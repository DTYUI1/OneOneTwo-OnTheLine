import { FieldCaption } from "../../shared/FieldHelp";
import { StopGenerationButton } from "../../shared/StopGenerationButton";
// Пакеты (D-01, п. 3): генерация через job с прогрессом «N из M» и повтором, разбор
// пакета, утверждение пригодных сценариев одной операцией пакета (C-05) с request_id.
// Неполный эталон отметить нельзя — он не выдаётся.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CoherenceBadge, CoherenceWarning } from "./CoherenceWarning";
import { api, csrfToken } from "../../shared/api";
import {
  RepeatGenerationDialog,
  repeatMessage,
} from "./RepeatGenerationDialog";
import { ThemeSelection, type Category } from "../console/ThemeSelection";
import { AIResourceDialog } from "../console/AIResourceDialog";
import { generationActive } from "../../shared/aiProgress";
import { GenerationProgress } from "../../shared/GenerationProgress";
import {
  JOB_LABELS,
  displayPackTitle,
  packPersonalization,
  newPack,
  readiness,
  summarizePack,
  type Job,
  type Pack,
} from "./packModel";
import { ORIGIN_LABELS, STATUS_LABELS, type Service } from "./studioModel";
import kit from "../console/Console.module.css";
import styles from "./Studio.module.css";
import {
  GenerationTraineePicker,
  type GenerationTrainee,
} from "./GenerationTraineePicker";
import { SortHeading } from "./SortHeading";
import {
  NEWEST_FIRST,
  sortedRows,
  creationTime,
  creationDate,
  type SortState,
} from "./sorting";
import { isDdsService } from "../../shared/services";

export function PacksPanel({
  services,
  onOpenScenario,
}: {
  services: Service[];
  onOpenScenario: (id: string) => void;
}) {
  const queries = useQueryClient();
  const [sort, setSort] = useState<SortState>(NEWEST_FIRST);
  // Выключенной службе сервер пакет не соберёт (422) — не предлагаем.
  const active = services.filter(
    (service) => service.is_active && isDdsService(service),
  );
  const [params, setParams] = useState({
    service_id: active[0]?.id ?? "",
    level: 1,
    count: 1,
    seed: "",
    categories: [] as Category[],
  });
  useEffect(() => {
    if (!params.service_id && active[0])
      setParams((current) => ({ ...current, service_id: active[0].id }));
  }, [active, params.service_id]);
  const [trainee, setTrainee] = useState<GenerationTrainee | null>(null);
  const [manualLevel, setManualLevel] = useState(false);
  const recommendation = useQuery({
    queryKey: ["generation-trainees", trainee?.login ?? "", params.service_id],
    enabled: Boolean(trainee && params.service_id),
    queryFn: async () => {
      const { data, error } = await api.GET("/packs/generation-trainees", {
        params: {
          query: { login: trainee!.login, service_id: params.service_id },
        },
      });
      if (!data) throw new Error(error?.message ?? "Рекомендация недоступна.");
      return data;
    },
  });
  const suggested = recommendation.data?.find(
    (item) => item.id === trainee?.id,
  );
  const waitingForLevel = Boolean(
    trainee && !manualLevel && recommendation.isPending,
  );
  useEffect(() => {
    if (!suggested) return;
    setTrainee((current) =>
      current?.id === suggested.id &&
      (current.recommended_level !== suggested.recommended_level ||
        current.explanation !== suggested.explanation)
        ? suggested
        : current,
    );
    // Рекомендация относится к ключу выбранной службы, ручной уровень она не заменяет.
    if (!manualLevel)
      setParams((current) =>
        current.level === suggested.recommended_level
          ? current
          : { ...current, level: suggested.recommended_level },
      );
  }, [suggested, manualLevel]);
  const [jobId, setJobId] = useState<string | null>(null);
  const handled = useRef<string | null>(null);
  const [packsBefore, setPacksBefore] = useState<Pack[]>([]);
  const [openPackId, setOpenPackId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState(false);
  const [repeatWarning, setRepeatWarning] = useState<{
    left: number;
    count: number;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const attempt = useRef<{ key: string; id: string } | null>(null);
  const recent = useQuery({
    queryKey: ["generation-jobs"],
    queryFn: async () => {
      const { data, error } = await api.GET("/packs/generation-jobs");
      if (!data) throw new Error(error?.message ?? "Очередь недоступна.");
      return data;
    },
    staleTime: 0,
  });
  useEffect(() => {
    if (!jobId && !inFlight.current && recent.data?.[0]) {
      setJobId(recent.data[0].job.id);
    }
  }, [jobId, recent.data]);

  const packs = useQuery({
    queryKey: ["packs"],
    queryFn: async () => {
      const { data, error } = await api.GET("/packs");
      if (!data) throw new Error(error?.message ?? "Пакеты недоступны.");
      return data;
    },
  });
  const openPack = packs.data?.find((pack) => pack.id === openPackId) ?? null;
  useEffect(() => {
    if (packs.isSuccess && openPackId && !openPack) setOpenPackId(null);
  }, [packs.isSuccess, openPackId, openPack]);
  const variety = useQuery({
    queryKey: [
      "generation-variety",
      trainee?.login,
      params.service_id,
      params.level,
      params.categories,
    ],
    enabled: Boolean(params.service_id),
    queryFn: async () => {
      const { data, error } = await api.GET("/packs/generation-variety", {
        params: {
          query: {
            service_id: params.service_id,
            level: params.level,
            categories: params.categories,
            trainee_login: trainee?.login,
          },
        },
      });
      if (!data)
        throw new Error(error?.message ?? "Количество историй недоступно.");
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
      ["done", "failed", "cancelled"].includes(query.state.data.job.status)
        ? false
        : 1500,
  });
  const progress = jobQuery.data ?? null;
  const job: Job | null = progress?.job ?? null;
  // Пока генерация идёт или ждёт — полоса хода, после — итог строкой.
  const state = progress?.generation_state;
  const running = state && generationActive(state) ? state : null;

  useEffect(() => {
    if (
      !jobId ||
      !job ||
      !["done", "cancelled"].includes(job.status) ||
      handled.current === jobId
    )
      return;
    handled.current = jobId;
    void (async () => {
      const fresh = await queries.fetchQuery({
        queryKey: ["packs"],
        queryFn: async () => (await api.GET("/packs")).data ?? [],
        staleTime: 0,
      });
      await queries.invalidateQueries({ queryKey: ["scenarios"] });
      await queries.invalidateQueries({ queryKey: ["generation-variety"] });
      // Пакет задания называет сервер; без него — новый пакет в списке.
      const made = progress?.pack_id ?? newPack(packsBefore, fresh)?.id;
      if (
        made &&
        fresh.some((pack) => pack.id === made && pack.scenario_ids.length > 0)
      )
        setOpenPackId(made);
    })();
  }, [job?.status, jobId, packsBefore, progress?.pack_id, queries]);

  const generate = async (policy?: "now", repeatsConfirmed = false) => {
    if (inFlight.current || waitingForLevel) return;
    inFlight.current = true;
    setSubmitting(true);
    setError("");
    try {
      if (!repeatsConfirmed) {
        const fresh = await variety.refetch();
        if (fresh.error || !fresh.data)
          throw new Error("Не удалось проверить оставшиеся варианты.");
        const left = fresh.data.variants_left;
        if (repeatMessage(left, params.count)) {
          setRepeatWarning({ left, count: params.count });
          return;
        }
      }
      if (!policy) {
        const { data, error } = await api.GET("/ai/resource");
        if (!data)
          throw new Error(
            error?.message ?? "Не удалось проверить состояние ИИ.",
          );
        if (data.local_ai && data.lesson_running) {
          setWarning(true);
          return;
        }
      }
      const generation_policy = "now" as const;
      const key = JSON.stringify({
        ...params,
        trainee_login: trainee?.login,
        generation_policy,
      });
      if (attempt.current?.key !== key)
        attempt.current = { key, id: crypto.randomUUID() };
      setPacksBefore(packs.data ?? []);
      const { data, error } = await api.POST("/packs/generate", {
        params: { header: { "X-CSRF-Token": csrfToken() } },
        body: {
          ...params,
          trainee_login: trainee?.login,
          seed: params.seed === "" ? undefined : Number(params.seed),
          generation_policy,
          generation_request_id: attempt.current.id,
        },
      });
      if (!data) return setError(error?.message ?? "Генерация не запустилась.");
      setJobId(data.id);
      attempt.current = null;
      await queries.invalidateQueries({ queryKey: ["generation-jobs"] });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Генерация не запустилась.",
      );
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  const busy =
    job?.status === "pending" ||
    job?.status === "running" ||
    Boolean(jobId && !job);

  return (
    <div className={kit.tabBody}>
      {repeatWarning && (
        <RepeatGenerationDialog
          {...repeatWarning}
          onChoose={(confirmed) => {
            setRepeatWarning(null);
            if (confirmed) void generate(undefined, true);
          }}
        />
      )}
      {warning && (
        <AIResourceDialog
          action="generate"
          onChoose={(choice) => {
            setWarning(false);
            if (choice === "now") void generate("now", true);
          }}
        />
      )}
      <div className={kit.panel}>
        <h3 className={kit.panelTitle}>Сгенерировать пакет</h3>
        <GenerationTraineePicker
          value={trainee}
          serviceId={params.service_id}
          disabled={submitting || warning || Boolean(repeatWarning)}
          onChange={(selected) => {
            setTrainee(selected);
            if (selected) {
              setManualLevel(false);
              setParams((previous) => ({
                ...previous,
                level: selected.recommended_level,
              }));
            }
          }}
        />
        <div className={kit.actions}>
          <label className={kit.field}>
            <FieldCaption
              label="Служба"
              help="Служба, для которой создаются задания."
            />
            <select
              aria-label="Служба"
              value={params.service_id}
              disabled={submitting || warning || Boolean(repeatWarning)}
              onChange={(event) =>
                setParams({
                  ...params,
                  service_id: event.target.value,
                  level: manualLevel ? params.level : 1,
                })
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
            <FieldCaption
              label="Уровень"
              help="Сложность заданий: 1 — простые, 4 — самые сложные."
            />
            <select
              aria-label="Уровень"
              value={params.level}
              disabled={submitting || warning || Boolean(repeatWarning)}
              onChange={(event) => {
                setManualLevel(true);
                setParams({ ...params, level: Number(event.target.value) });
              }}
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
              disabled={submitting || warning || Boolean(repeatWarning)}
              className={kit.number}
              onChange={(event) =>
                setParams({ ...params, count: Number(event.target.value) })
              }
            />
          </label>
          <button
            type="button"
            className={kit.primary}
            disabled={
              busy ||
              submitting ||
              warning ||
              Boolean(repeatWarning) ||
              recent.isPending ||
              waitingForLevel ||
              !params.service_id ||
              params.count < 1 ||
              params.count > 100
            }
            onClick={() => void generate()}
          >
            {submitting
              ? "Сохраняем…"
              : busy
                ? "Задание в очереди"
                : recent.isPending
                  ? "Проверяем очередь…"
                  : "Сгенерировать"}
          </button>
        </div>
        {recent.isError && (
          <p role="alert">
            Не удалось проверить очередь: {recent.error.message}{" "}
            <button
              type="button"
              className={kit.plain}
              disabled={recent.isFetching}
              onClick={() => void recent.refetch()}
            >
              Повторить
            </button>
          </p>
        )}
        <ThemeSelection
          value={params.categories}
          onChange={(categories) => setParams({ ...params, categories })}
          disabled={submitting || warning || Boolean(repeatWarning)}
        />
        {variety.data !== undefined && (
          <p className={kit.hint}>
            Сюжетов: {variety.data.count} · вариантов прохождения:{" "}
            {variety.data.variants_total}, новых: {variety.data.variants_left}
            {params.count > variety.data.count &&
              " Сценариев больше — истории повторятся, но доклады и заявитель будут другими."}
          </p>
        )}
        {variety.isError && (
          <p className={kit.hint}>Количество историй недоступно.</p>
        )}
        <details className={styles.generationAdvanced}>
          <summary>Дополнительно</summary>
          <label className={kit.field}>
            <FieldCaption
              label="Число для генерации"
              help="Необязательно. Это число влияет на выбор сценариев. Уже использованные варианты тоже учитываются, поэтому одно число не гарантирует повторения."
            />
            <input
              aria-label="Число для генерации"
              placeholder="Случайно"
              type="number"
              value={params.seed}
              disabled={submitting || warning || Boolean(repeatWarning)}
              className={styles.seedInput}
              onChange={(event) =>
                setParams({ ...params, seed: event.target.value })
              }
            />
          </label>
          <p className={kit.hint}>
            Можно оставить пустым — число выберется автоматически. Оно влияет на
            выбор сценариев. С тем же числом истории могут отличаться: уже
            использованные варианты учитываются при выборе.
          </p>
        </details>
        <p className={kit.hint}>
          Сгенерированные сценарии приходят черновиками — выдать их можно только
          после утверждения.
        </p>
        {progress && running && (
          <GenerationProgress
            key={jobId}
            expectedSeconds={progress.estimated_item_seconds}
            state={running}
            completed={progress.completed}
            total={progress.total}
          />
        )}
        {progress && running && (
          <StopGenerationButton
            jobId={progress.job.id}
            stopping={state === "stopping"}
          />
        )}
        {job?.status === "cancelled" && progress && (
          <p role="status">
            Остановлено: готово {progress.completed} из {progress.total}.
            {progress.completed > 0
              ? " Готовые сценарии сохранены в пакете."
              : " Сценарии не созданы."}
          </p>
        )}
        {job && !running && job.status !== "cancelled" && (
          <p
            className={job.status === "failed" ? kit.problems : kit.hint}
            role={job.status === "failed" ? "alert" : "status"}
          >
            Генерация:{" "}
            {progress?.generation_state === "waiting"
              ? "Ожидает окончания занятия"
              : progress?.generation_state === "queued"
                ? "В очереди"
                : JOB_LABELS[job.status]}
            {progress &&
              (job.status === "done"
                ? ` · сценариев: ${progress.completed}`
                : job.status === "failed"
                  ? ` · успели ${progress.completed} из ${progress.total}`
                  : "")}
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
        {progress?.warnings.map((warning) => (
          <p key={warning} className={kit.hint}>
            {warning
              .replace(/^Покрыто пар:/, "Использовано сочетаний деталей:")
              .replace(/^Шаблонный путь:/, "Сценариев по готовым шаблонам:")
              .replace("это не ИИ-генерация.", "использованы готовые шаблоны.")}
          </p>
        ))}
        {jobQuery.isError && (
          <p role="alert">Статус генерации не читается — проверьте связь.</p>
        )}
        {error && <p role="alert">{error}</p>}
      </div>

      {openPackId && openPack ? (
        <PackView
          packId={openPackId}
          pack={openPack}
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
                  <SortHeading
                    label="Пакет"
                    field="title"
                    sort={sort}
                    onSort={setSort}
                  />
                  <SortHeading
                    label="Сценариев"
                    field="count"
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
                </tr>
              </thead>
              <tbody>
                {sortedRows(packs.data ?? [], sort, (pack, key) => {
                  switch (key) {
                    case "title":
                      return displayPackTitle(pack.title);
                    case "count":
                      return pack.scenario_ids.length;
                    case "status":
                      return STATUS_LABELS[pack.status];
                    case "origin":
                      return ORIGIN_LABELS[pack.origin];
                    default:
                      return creationTime(pack.created_at);
                  }
                }).map((pack) => (
                  <tr key={pack.id}>
                    <td>
                      <button
                        type="button"
                        className={styles.titleLink}
                        onClick={() => setOpenPackId(pack.id)}
                      >
                        {displayPackTitle(pack.title)}
                      </button>
                      <PackPersonalization title={pack.title} />
                    </td>
                    <td>{pack.scenario_ids.length}</td>
                    <td>{STATUS_LABELS[pack.status]}</td>
                    <td>{ORIGIN_LABELS[pack.origin]}</td>
                    <td>{creationDate(pack.created_at)}</td>
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
  const [coherenceWarning, setCoherenceWarning] = useState(false);
  const [failure, setFailure] = useState("");
  const [rejecting, setRejecting] = useState("");
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
  const approve = async (confirmed = false) => {
    if (
      !confirmed &&
      members.some((s) => checked.includes(s.id) && s.coherence_unchecked)
    ) {
      setCoherenceWarning(true);
      return;
    }
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

  // Отклонённый сценарий уходит в архив: больше не выдаётся, история остаётся.
  const reject = async (scenario: (typeof members)[number]) => {
    setRejecting(scenario.id);
    setFailure("");
    const { data, error } = await api.POST("/scenarios/{id}/retire", {
      params: {
        path: { id: scenario.id },
        header: { "X-CSRF-Token": csrfToken() },
      },
    });
    setRejecting("");
    if (!data) return setFailure(error?.message ?? "Не удалось отклонить.");
    setResults({ ...results, [scenario.id]: "отклонён, больше не выдаётся" });
    setChecked(checked.filter((id) => id !== scenario.id));
    await queries.invalidateQueries({ queryKey: ["scenarios"] });
  };

  if (!pack)
    return (
      <p className={kit.placeholder}>
        Пакет {packId.slice(0, 8)} не найден.{" "}
        <button type="button" className={kit.plain} onClick={onBack}>
          ← Назад к списку
        </button>
      </p>
    );

  return (
    <div className={kit.panel}>
      {coherenceWarning && (
        <CoherenceWarning
          onChoose={(confirmed) => {
            setCoherenceWarning(false);
            if (confirmed) void approve(true);
          }}
        />
      )}
      <div className={kit.actions}>
        <h3 className={kit.panelTitle}>{displayPackTitle(pack.title)}</h3>
        <button type="button" className={kit.plain} onClick={onBack}>
          ← Назад к списку
        </button>
      </div>
      <PackPersonalization title={pack.title} />
      <p className={kit.hint}>
        всего {summary.total} · утверждено {summary.approved} · готовы к
        утверждению {summary.ready} · требуют правки {summary.blocked}
      </p>
      <table className={kit.table}>
        <thead>
          <tr>
            <th aria-label="Выбор" className={kit.pick} />
            <th>Происшествие</th>
            <th>Вариант</th>
            <th>Служба</th>
            <th>Ур.</th>
            <th>Статус</th>
            <th>Готовность</th>
            <th aria-label="Действия" />
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
                <td>{scenario.variant_label || "—"}</td>
                <td>{serviceName(scenario.target_service_id)}</td>
                <td>{scenario.level}</td>
                <td>
                  <span className={styles[`st_${scenario.status}`]}>
                    {STATUS_LABELS[scenario.status]}
                  </span>
                </td>
                <td>
                  <CoherenceBadge unchecked={scenario.coherence_unchecked} />
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
                <td className={kit.rowActions}>
                  {scenario.status === "draft" && (
                    <button
                      type="button"
                      className={kit.plain}
                      disabled={running || Boolean(rejecting)}
                      onClick={() => void reject(scenario)}
                    >
                      Отклонить
                    </button>
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
        правки, откройте в редакторе. Отклонённый сценарий уходит в архив и
        больше не выдаётся.
      </p>
    </div>
  );
}

function PackPersonalization({ title }: { title: string }) {
  const personal = packPersonalization(title);
  if (!personal) return null;
  if (!personal.errors.length)
    return <p className={kit.hint}>{personal.explanation}</p>;
  return (
    <details className={styles.personalization}>
      <summary>Ранее допускал ошибки</summary>
      <ul>
        {personal.errors.map((item, index) => (
          <li key={index}>
            {item.skill}. Этот навык отрабатывается в {item.count} из{" "}
            {item.total}{" "}
            {item.total % 10 === 1 && item.total % 100 !== 11
              ? "карточки"
              : "карточек"}{" "}
            пакета.
          </li>
        ))}
      </ul>
      <p className={kit.hint}>
        Одна карточка может отрабатывать несколько навыков. Это количество
        карточек, а не ошибок обучаемого.
      </p>
    </details>
  );
}
