import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, csrfToken } from "../../shared/api";
import { GenerationProgress } from "../../shared/GenerationProgress";
import { generationActive } from "../../shared/aiProgress";
import kit from "../console/Console.module.css";

export function CorrectionPanel({
  scenarioId,
  disabled,
  onBusy,
  onReplaced,
}: {
  scenarioId: string;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  onReplaced: (id: string) => Promise<void>;
}) {
  const queries = useQueryClient();
  const [note, setNote] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const opened = useRef<string | null>(null);
  const content = useQuery({
    queryKey: ["scenario-content", scenarioId],
    queryFn: async () =>
      (
        await api.GET("/scenarios/{id}/content", {
          params: { path: { id: scenarioId } },
        })
      ).data ?? null,
  });
  const progress = useQuery({
    queryKey: ["job-progress", jobId],
    enabled: Boolean(jobId),
    queryFn: async () => {
      const { data, error } = await api.GET("/jobs/{id}/progress", {
        params: { path: { id: jobId! } },
      });
      if (!data)
        throw new Error(
          error?.message ?? "Не удалось прочитать ход пересоздания.",
        );
      return data;
    },
    refetchInterval: (query) => {
      const status = query.state.data?.job.status;
      return status === "done" || status === "failed" ? false : 1000;
    },
  });
  const regenerate = useMutation({
    onMutate: () => {
      setError("");
      setJobId(null);
      opened.current = null;
    },
    mutationFn: async () => {
      const { data, error } = await api.POST("/scenarios/{id}/regenerate", {
        params: {
          path: { id: scenarioId },
          header: { "X-CSRF-Token": csrfToken() },
        },
        body: { note: note.trim() },
      });
      if (!data)
        throw new Error(error?.message ?? "Не удалось запустить пересоздание.");
      return data;
    },
    onSuccess: (job) => {
      setError("");
      setJobId(job.id);
    },
    onError: (cause: Error) => setError(cause.message),
  });
  const state = progress.data?.generation_state ?? "queued";
  const busy =
    regenerate.isPending || Boolean(jobId && generationActive(state));
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);
  const replacement =
    progress.data?.job.status === "done"
      ? progress.data.scenario_ids[0]
      : undefined;
  useEffect(() => {
    if (!replacement || opened.current === replacement) return;
    opened.current = replacement;
    void Promise.all([
      queries.invalidateQueries({ queryKey: ["scenarios"] }),
      queries.invalidateQueries({ queryKey: ["packs"] }),
      queries.invalidateQueries({ queryKey: ["generation-variety"] }),
    ])
      .then(() => onReplaced(replacement))
      .catch((cause: Error) => setError(cause.message));
  }, [replacement, onReplaced, queries]);
  if (!content.data?.can_regenerate && !jobId) return null;
  return (
    <section>
      <label className={kit.field}>
        Замечание для ИИ
        <textarea
          rows={3}
          maxLength={2000}
          value={note}
          disabled={busy || disabled}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      <p className={kit.hint}>
        Уровень сложности и основная история не меняются. Можно попросить: другой исход,
        вопрос бригады раньше или позже, другие доклады, без молчания бригады.
        Изменения возможны в пределах выбранного уровня и доступных вариантов.
        Для другого уровня сгенерируйте новый пакет с нужным уровнем.
      </p>
      {disabled && (
        <p className={kit.hint}>
          Сначала сохраните или отмените правки редактора.
        </p>
      )}
      <button
        type="button"
        className={kit.primary}
        disabled={busy || disabled || !note.trim()}
        onClick={() => regenerate.mutate()}
      >
        Пересоздать
      </button>
      {jobId && (
        <GenerationProgress
          key={jobId}
          expectedSeconds={progress.data?.estimated_item_seconds}
          state={state}
          completed={progress.data?.completed ?? 0}
          total={1}
        />
      )}
      {(error || progress.error || progress.data?.job.error) && (
        <p role="alert" className={kit.warning}>
          {error || progress.error?.message || progress.data?.job.error}{" "}
          {replacement
            ? "Новый сценарий создан, но не удалось его открыть. Нажмите «Открыть новый сценарий»."
            : progress.error
              ? "Не удалось узнать состояние задания. Обновите страницу, чтобы проверить результат."
              : "Уточните замечание с учётом подсказки выше и нажмите «Пересоздать». При сбое связи повторите позже."}
        </p>
      )}
      {replacement && (
        <button
          type="button"
          onClick={() =>
            void onReplaced(replacement).catch((cause: Error) =>
              setError(cause.message),
            )
          }
        >
          Открыть новый сценарий
        </button>
      )}
    </section>
  );
}
