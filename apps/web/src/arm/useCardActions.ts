// Отправка действий диспетчера. Очередь, повторы и порядок — в shared/ws (капитан),
// здесь только конверт события: client_event_id и client_ts создаются один раз до записи.
import { useCallback, useMemo, useRef } from "react";
import type { CardEvent } from "../shared/api";
import { useSession } from "../shared/session";
import type { DispatcherStatus } from "./cardModel";

type EventBody =
  | { type: "deliver"; payload: Record<string, never> }
  | { type: "open"; payload: Record<string, never> }
  | {
      type: "field_change";
      payload: { field: "service_number" | "comment"; value: string };
    }
  | {
      type: "field_change";
      payload: { field: "address"; value: ManualAddress };
    }
  | {
      type: "status_change";
      payload: { state: DispatcherStatus; comment: string };
    }
  | { type: "redirect"; payload: { service_id: string; comment: string } }
  | { type: "hint_open"; payload: { hint_id: string } };

/** Адрес, введённый обучаемым вручную (CardCurrent.address), — отдельно от source.address. */
export interface ManualAddress {
  city: string;
  street: string;
  house: string;
  building: string;
  apartment: string;
}

export function useCardActions(cardId: string, enabled: boolean) {
  const { realtime } = useSession();
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const send = useCallback(
    async (body: EventBody): Promise<boolean> => {
      // Повторная проверка нужна и для обработчика, продолжившегося после await.
      if (!enabledRef.current) return false;
      await realtime.enqueue(cardId, {
        client_event_id: crypto.randomUUID(),
        client_ts: new Date().toISOString(),
        ...body,
      } as CardEvent);
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
      /** Ручной ввод адреса обучаемым; исходный адрес карточки не меняется. */
      addressChange: (value: ManualAddress) =>
        send({ type: "field_change", payload: { field: "address", value } }),
      statusChange: (state: DispatcherStatus, comment: string) =>
        send({ type: "status_change", payload: { state, comment } }),
      /** Обучаемый открыл подсказку начального уровня — фиксируем для разбора. */
      hintOpen: (hintId: string) =>
        send({ type: "hint_open", payload: { hint_id: hintId } }),
      redirect: (serviceId: string, comment: string) =>
        send({ type: "redirect", payload: { service_id: serviceId, comment } }),
    }),
    [send],
  );
}
