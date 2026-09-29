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
): Promise<AttemptAnalysis | null> {
  const { data } = await api.GET("/cards/{id}/analysis", {
    params: { path: { id: cardId } },
    signal,
  });
  return data ?? null;
}

export function useAttemptAnalysis(cardId: string) {
  return useQuery({
    queryKey: ["analysis", cardId],
    queryFn: ({ signal }) => fetchAnalysis(cardId, signal),
  });
}

export function useAttemptAnalyses(cardIds: string[]) {
  const results = useQueries({
    queries: cardIds.map((cardId) => ({
      // Отдельный ключ: выбранная карточка не ждёт своей очереди в сводке.
      queryKey: ["analysis", cardId, "summary"],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        summaryQueue(() => fetchAnalysis(cardId, signal), signal),
    })),
  });
  const byCard = new Map<string, AttemptAnalysis>();
  results.forEach((result, index) => {
    if (result.data) byCard.set(cardIds[index], result.data);
  });
  return byCard;
}
