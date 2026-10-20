// Отправка действий диспетчера. Очередь, повторы и порядок — в shared/ws (капитан),
// здесь только конверт события: client_event_id и client_ts создаются один раз до записи.
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef } from "react";
import type { Card, CardEvent } from "../shared/api";
import { useSession } from "../shared/session";
import { withConfirmedState, type DispatcherStatus } from "./cardModel";

type EventBody =
  | { type: "deliver"; payload: Record<string, never> }
  | { type: "open"; payload: Record<string, never> }
  | {
      type: "field_change";
      payload: { field: "service_number" | "comment"; value: string };
    }
  | {
      type: "status_change";
      payload: { state: DispatcherStatus; comment: string };
    }
  | { type: "redirect"; payload: { service_id: string; comment: string } }
  | { type: "hint_open"; payload: { hint_id: string } };

// enqueue может ещё писать в IndexedDB: одного снимка pending для перехвата мало.
const enqueuing = new Map<string, Set<Promise<void>>>();

/** Дождаться начатых записей/отправок; ACK затем отдельно проверяется по outbox. */
export async function settleCardActions(cardId: string): Promise<void> {
  while (enqueuing.get(cardId)?.size)
    await Promise.allSettled([...enqueuing.get(cardId)!]);
}

export function useCardActions(cardId: string, enabled: boolean) {
  const { realtime } = useSession();
  const queries = useQueryClient();
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const send = useCallback(
    async (body: EventBody): Promise<boolean> => {
      // Повторная проверка нужна и для обработчика, продолжившегося после await.
      if (!enabledRef.current) return false;
      const queued = realtime.enqueue(cardId, {
        client_event_id: crypto.randomUUID(),
        client_ts: new Date().toISOString(),
        ...body,
      } as CardEvent);
      const active = enqueuing.get(cardId) ?? new Set<Promise<void>>();
      enqueuing.set(cardId, active);
      active.add(queued);
      try {
        await queued;
      } finally {
        active.delete(queued);
        if (!active.size) enqueuing.delete(cardId);
      }
      // enqueue сохраняет даже отклонённое действие для разбора. Не показываем
      // форму как успешно сохранённую, если сервер уже остановил эту карточку.
      return !(await realtime.pending()).some(
        (item) => item.cardId === cardId && item.failure,
      );
    },
    [realtime, cardId],
  );
  return useMemo(
    () => ({
      /** Строка показана обучаемому — от этого события считается время реакции. */
      deliver: () => send({ type: "deliver", payload: {} }),
      /** Карточка открыта; статус не меняет (ws-events.md). */
      open: () => send({ type: "open", payload: {} }),
      fieldChange: (field: "service_number" | "comment", value: string) =>
        send({ type: "field_change", payload: { field, value } }),
      statusChange: async (state: DispatcherStatus, comment: string) => {
        const accepted = await send({
          type: "status_change",
          payload: { state, comment },
        });
        if (accepted) {
          // Сервер статус принял — окно телефона и строка статуса видят его сразу, не
          // дожидаясь сокета (`withConfirmedState`). Запрос списка, начатый до статуса,
          // отменяем: его ответ вернул бы прежний статус; свежий список — следом.
          await queries.cancelQueries({ queryKey: ["cards"] });
          queries.setQueryData<Card[]>(["cards"], (cards) =>
            withConfirmedState(cards, cardId, state),
          );
          void queries.invalidateQueries({ queryKey: ["cards"] });
        }
        return accepted;
      },
      /** Обучаемый открыл подсказку начального уровня — фиксируем для разбора. */
      hintOpen: (hintId: string) =>
        send({ type: "hint_open", payload: { hint_id: hintId } }),
      redirect: (serviceId: string, comment: string) =>
        send({ type: "redirect", payload: { service_id: serviceId, comment } }),
    }),
    [send, cardId, queries],
  );
}
