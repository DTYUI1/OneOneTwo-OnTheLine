// Данные I-BRIGADE с сервера (C-04): бригады и адресаты своей ДДС, ручной выбор
// и выданные сведения карточки. План сообщений принадлежит преподавателю и сюда
// не приходит — обучаемый видит только то, что сервер уже выдал.

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../shared/api";
import { useSession } from "../../../shared/session";
import type { components } from "../../../api-client/schema";

type Brigade = components["schemas"]["Brigade"];
type CallTarget = components["schemas"]["CallTarget"];
type CardTraining = components["schemas"]["CardTraining"];

export interface BrigadeData {
  readonly brigades: readonly Brigade[];
  readonly targets: readonly CallTarget[];
  readonly training: CardTraining | null;
  /** Сервер не отдал справочник: панель скрывается, звонки в службы работают. */
  readonly unavailable: boolean;
  readonly refresh: () => void;
  /** Свежие сведения с сервера прямо сейчас; `null` — связи нет. */
  readonly reload: () => Promise<CardTraining | null>;
}

const EMPTY: readonly never[] = [];

export function trainingKey(cardId: string) {
  return ["card-training", cardId] as const;
}

/** Один запрос сведений карточки для софтфона и вкладок происшествий (общий кэш). */
export function trainingQuery(cardId: string) {
  return {
    queryKey: trainingKey(cardId),
    queryFn: async () => {
      const { data, error } = await api.GET("/cards/{id}/training", {
        params: { path: { id: cardId } },
      });
      if (!data) throw new Error(error?.message ?? "Сведения недоступны.");
      return data;
    },
  };
}

/**
 * `live` — идёт разговор: сведения выдаёт worker по сроку плана, и WS
 * `training.updated` может не дойти при обрыве, поэтому в разговоре чтение
 * повторяется. Вне разговора хватает уведомления и перечитывания при reconnect.
 */
export function useBrigadeData(
  cardId: string,
  serviceId: string | null,
  live: boolean,
): BrigadeData {
  const client = useQueryClient();
  const { realtime } = useSession();

  const brigades = useQuery({
    queryKey: ["brigades", serviceId],
    enabled: serviceId !== null,
    retry: false,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await api.GET("/services/{id}/brigades", {
        params: { path: { id: serviceId as string } },
      });
      if (!data) throw new Error(error?.message ?? "Бригады недоступны.");
      return data.filter((item) => item.is_active);
    },
  });

  const targets = useQuery({
    queryKey: ["call-targets", serviceId],
    enabled: serviceId !== null,
    retry: false,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await api.GET("/services/{id}/call-targets", {
        params: { path: { id: serviceId as string } },
      });
      if (!data) throw new Error(error?.message ?? "Адресаты недоступны.");
      return data.filter((item) => item.is_active);
    },
  });

  const training = useQuery({
    ...trainingQuery(cardId),
    enabled: serviceId !== null,
    retry: false,
    refetchInterval: live ? 2000 : false,
  });

  // Уведомление только инвалидирует чтение: состояние берём из GET training.
  // Свой статус меняет доступные этапы, а закрытие других карточек освобождает
  // занятые бригады. В обоих случаях перечитываем общую проекцию (28.09).
  useEffect(() => {
    return realtime.subscribe((event) => {
      if (
        event.type === "training.updated" ||
        event.type === "snapshot" ||
        (event.type === "card.updated" &&
          (event.payload.id === cardId || event.payload.closed_at !== null))
      )
        void client.invalidateQueries({ queryKey: trainingKey(cardId) });
    });
  }, [realtime, client, cardId]);

  return {
    brigades: brigades.data ?? EMPTY,
    targets: targets.data ?? EMPTY,
    training: training.data ?? null,
    unavailable: brigades.isError || targets.isError || training.isError,
    refresh: () =>
      void client.invalidateQueries({ queryKey: trainingKey(cardId) }),
    reload: () =>
      client
        .fetchQuery({ ...trainingQuery(cardId), staleTime: 0 })
        .catch(() => null),
  };
}
