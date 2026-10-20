// Разбор попытки с сервера (GET /cards/{id}/analysis, C-02/C-06): время по версии
// методики занятия, слои оценки и решение преподавателя. Итоговые цифры берём
// отсюда, а не считаем на экране.
import { useQueries, useQuery } from "@tanstack/react-query";
import { api } from "../shared/api";
import type { components } from "../api-client/schema";
import { createRequestQueue } from "./requestQueue";

export type AttemptAnalysis = components["schemas"]["AttemptAnalysis"];
export type TimingResult = components["schemas"]["TimingResult"];

const summaryQueue = createRequestQueue(3);

async function fetchAnalysis(
  cardId: string,
  signal: AbortSignal,
): Promise<AttemptAnalysis> {
  const { data, error } = await api.GET("/cards/{id}/analysis", {
    params: { path: { id: cardId } },
    signal,
  });
  if (!data)
    throw new Error(error?.message ?? "Не удалось загрузить разбор попытки.");
  return data;
}

export interface AnalysisTarget {
  cardId: string;
  evaluationId: string | null;
  evaluationVersion: number | null;
  /** Override не повышает version, поэтому нужен ещё ключ наблюдаемой оценки. */
  evaluationRevision?: string | null;
  effectiveTotal?: number | null;
}

export function analysisRevision(
  evaluation: Pick<
    components["schemas"]["Evaluation"],
    "total" | "status" | "teacher_comment"
  > | null,
): string | null {
  return evaluation
    ? JSON.stringify([
        evaluation.total,
        evaluation.status,
        evaluation.teacher_comment,
      ])
    : null;
}

export function analysisOutdated(
  analysis: AttemptAnalysis | undefined,
  target: AnalysisTarget,
): boolean {
  return (
    target.evaluationId !== null &&
    analysis !== undefined &&
    (analysis.evaluation?.evaluation_id !== target.evaluationId ||
      analysis.evaluation.evaluation_version !== target.evaluationVersion ||
      (target.effectiveTotal !== undefined &&
        target.effectiveTotal !== null &&
        (analysis.evaluation?.effective_total == null ||
          Math.abs(
            analysis.evaluation.effective_total - target.effectiveTotal,
          ) > 0.00001)))
  );
}

export function useAttemptAnalysis(target: AnalysisTarget) {
  return useQuery({
    queryKey: [
      "analysis",
      target.cardId,
      target.evaluationId,
      target.evaluationVersion,
      target.evaluationRevision,
    ],
    queryFn: ({ signal }) => fetchAnalysis(target.cardId, signal),
    refetchInterval: (query) =>
      analysisOutdated(query.state.data, target) ? 5_000 : false,
  });
}

export function useAttemptAnalyses(targets: AnalysisTarget[]) {
  const results = useQueries({
    queries: targets.map((target) => ({
      // Отдельный ключ: выбранная карточка не ждёт своей очереди в сводке.
      queryKey: [
        "analysis",
        target.cardId,
        target.evaluationId,
        target.evaluationVersion,
        target.evaluationRevision,
        "summary",
      ],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        summaryQueue(() => fetchAnalysis(target.cardId, signal), signal),
      refetchInterval: (query: { state: { data?: AttemptAnalysis } }) =>
        analysisOutdated(query.state.data, target) ? 5_000 : false,
    })),
  });
  const byCard = new Map<string, AttemptAnalysis>();
  const failed = new Set<string>();
  results.forEach((result, index) => {
    // Инвалидация после решения преподавателя оставляет старые данные в кеше,
    // пока идёт запрос. Не показываем старый вердикт как окончательный.
    if (result.data && !result.isFetching && !result.isError)
      byCard.set(targets[index].cardId, result.data);
    if (result.isError && !result.isFetching) failed.add(targets[index].cardId);
  });
  return {
    byCard,
    failed,
    retryFailed: async () => {
      await Promise.all(
        results
          .filter((result) => result.isError)
          .map((result) => result.refetch()),
      );
    },
  };
}
