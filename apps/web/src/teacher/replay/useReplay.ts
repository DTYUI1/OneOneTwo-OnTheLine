// Данные реплея одной карточки: журнал, службы, нормативы и вердикт.
// Занятие уже прошло, поэтому WS здесь не нужен — читаем один раз.
// Для времени — снимок методики занятия и итог сервера по попытке (с ожиданием
// сведений); для бригад — тексты докладов и адресаты звонков. Их отсутствие
// разбор не ломает: время тогда считается здесь, доклады — без текста.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api";
import type { components } from "../../api-client/schema";
import {
  buildTimeline,
  type Card,
  type CallTarget,
  type InformationEvidence,
  type Service,
  type Settings,
  type StoredEvent,
  type Timeline,
  type TimelineInput,
  type TimingContext,
  type TimingResult,
} from "./timeline";

export type Evaluation = components["schemas"]["Evaluation"];

export interface ReplayView {
  readonly input: TimelineInput | null;
  readonly timeline: Timeline | null;
  readonly evaluation: Evaluation | null;
  readonly loading: boolean;
  readonly error: string | null;
}

export function useReplay(cardId: string): ReplayView {
  const query = useQuery({
    queryKey: ["replay", cardId],
    queryFn: async () => {
      const [card, events, services, evaluations] = await Promise.all([
        api.GET("/cards/{id}", { params: { path: { id: cardId } } }),
        api.GET("/cards/{id}/events", { params: { path: { id: cardId } } }),
        api.GET("/services"),
        api.GET("/evaluations"),
      ]);
      if (!card.data || !events.data || !services.data || !evaluations.data)
        throw new Error("Не удалось загрузить занятие.");
      // Нормативы фиксируются при создании занятия: текущие настройки могли измениться.
      const sessionId = card.data.session_id;
      const [lesson, lifecycle, analysis, training] = await Promise.all([
        api.GET("/sessions/{id}", { params: { path: { id: sessionId } } }),
        api.GET("/sessions/{id}/lifecycle", {
          params: { path: { id: sessionId } },
        }),
        api.GET("/cards/{id}/analysis", { params: { path: { id: cardId } } }),
        api.GET("/cards/{id}/training", { params: { path: { id: cardId } } }),
      ]);
      if (!lesson.data)
        throw new Error("Не удалось загрузить нормативы занятия.");
      const settings = lesson.data.settings_snapshot as Settings;
      const timing: TimingContext | null = lifecycle.data
        ? {
            sessionId,
            policy: lifecycle.data.timing_policy ?? null,
            legacyReactionS: settings.reaction_normative_s,
            legacyHandlingS: settings.handling_normative_s,
          }
        : null;
      // Бригады — своей ДДС участника в этом занятии, как на АРМ.
      const dds = lesson.data.participants.find(
        (item) => item.user_id === card.data.trainee_id,
      )?.dds_service_id;
      const targets = dds
        ? await api.GET("/services/{id}/call-targets", {
            params: { path: { id: dds } },
          })
        : null;
      return {
        card: card.data as Card,
        events: events.data as StoredEvent[],
        services: services.data as Service[],
        settings,
        evaluations: evaluations.data as Evaluation[],
        timing,
        analysis: (analysis.data?.timing ?? null) as TimingResult | null,
        messages: (training.data?.messages ?? []) as InformationEvidence[],
        targets: (targets?.data ?? []) as CallTarget[],
        callbacks: training.data?.callbacks ?? [],
      };
    },
  });

  const input = useMemo<TimelineInput | null>(
    () =>
      query.data
        ? {
            card: query.data.card,
            events: query.data.events,
            services: query.data.services,
            settings: query.data.settings,
            timing: query.data.timing,
            analysis: query.data.analysis,
            messages: query.data.messages,
            targets: query.data.targets,
            callbacks: query.data.callbacks,
          }
        : null,
    [query.data],
  );

  const timeline = useMemo(
    () => (input ? buildTimeline(input) : null),
    [input],
  );

  // Берём последнюю версию оценки; HTTP уже накладывает последнее решение преподавателя.
  const evaluation = useMemo(() => {
    const mine = (query.data?.evaluations ?? []).filter(
      (item) => item.card_id === cardId,
    );
    return mine.length > 0
      ? mine.reduce((best, item) => (item.version > best.version ? item : best))
      : null;
  }, [query.data, cardId]);

  return {
    input,
    timeline,
    evaluation,
    loading: query.isPending,
    error: query.isError ? "Не удалось загрузить занятие." : null,
  };
}
