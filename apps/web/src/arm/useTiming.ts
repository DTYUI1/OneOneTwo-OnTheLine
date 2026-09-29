// Живые таймеры карточки по общему расчёту C-02: политика — снимок занятия из
// /sessions/{id}/lifecycle, события — история карточки. Итоговое время попытки
// (с активной обработкой и ожиданием) показывает разбор по /cards/{id}/analysis.
import { useQuery } from "@tanstack/react-query";
import { api, type Card } from "../shared/api";
import { cardLiveTiming, type LiveTiming } from "./timingAdapter";

export function useCardEvents(cardId: string, enabled = true) {
  return useQuery({
    queryKey: ["card-events", cardId],
    enabled,
    // При уходе из длинного списка освобождаем соединения для открытой карточки.
    queryFn: async ({ signal }) => {
      const { data, error } = await api.GET("/cards/{id}/events", {
        params: { path: { id: cardId } },
        signal,
      });
      if (!data) throw new Error(error?.message ?? "Нет связи с сервером.");
      return data;
    },
  });
}

export function useTimingContext(sessionId: string, enabled = true) {
  const lifecycle = useQuery({
    queryKey: ["lifecycle", sessionId],
    enabled,
    queryFn: async ({ signal }) => {
      const { data } = await api.GET("/sessions/{id}/lifecycle", {
        params: { path: { id: sessionId } },
        signal,
      });
      return data ?? null;
    },
    staleTime: 60_000,
  });
  const session = useQuery({
    queryKey: ["session", sessionId],
    enabled,
    queryFn: async ({ signal }) => {
      const { data, error } = await api.GET("/sessions/{id}", {
        params: { path: { id: sessionId } },
        signal,
      });
      if (!data) throw new Error(error?.message ?? "Занятие недоступно.");
      return data;
    },
  });
  if (lifecycle.isPending || !session.data) return null;
  const snapshot = session.data.settings_snapshot;
  return {
    sessionId,
    // Нет политики (старое занятие или сервер без C-02) — legacy v1 по I-TIME.
    policy: lifecycle.data?.timing_policy ?? null,
    legacyReactionS: snapshot.reaction_normative_s,
    legacyHandlingS: snapshot.handling_normative_s,
  };
}

/** Живое время карточки; null, пока не загружены политика и история. */
export function useCardTiming(
  card: Card,
  now: number,
  enabled = true,
): LiveTiming | null {
  const context = useTimingContext(card.session_id, enabled);
  const events = useCardEvents(card.id, enabled);
  if (!context || !events.data) return null;
  return cardLiveTiming(card, events.data, context, now);
}

/** Уровень подсказок из снимка занятия: 1 — подсказки начального уровня включены. */
export function useHintsLevel(sessionId: string): number {
  const session = useQuery({
    queryKey: ["session", sessionId],
    queryFn: async ({ signal }) => {
      const { data, error } = await api.GET("/sessions/{id}", {
        params: { path: { id: sessionId } },
        signal,
      });
      if (!data) throw new Error(error?.message ?? "Занятие недоступно.");
      return data;
    },
  });
  return session.data?.settings_snapshot.hints_level ?? 0;
}

/**
 * Подтверждённое ожидание бригады по разбору сервера (журнал ожидания у клиента нет).
 * Пока бригада едет или работает, ожидание растёт — перечитываем раз в 5 с; этого
 * хватает, чтобы таймер обработки не краснел, пока диспетчер ждёт доклада.
 */
export function useWaitingS(cardId: string, enabled: boolean): number | null {
  const analysis = useQuery({
    queryKey: ["analysis", cardId, "waiting"],
    enabled,
    refetchInterval: enabled ? 5000 : false,
    queryFn: async ({ signal }) => {
      const { data } = await api.GET("/cards/{id}/analysis", {
        params: { path: { id: cardId } },
        signal,
      });
      return data?.timing.waiting_s ?? null;
    },
  });
  return enabled ? (analysis.data ?? null) : null;
}
