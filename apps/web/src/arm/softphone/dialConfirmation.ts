import type { CardEvent } from "../../shared/api";
import type { OutboxOutcome, PendingEvent } from "../../shared/ws/outbox";

interface DialClient {
  enqueue(cardId: string, event: CardEvent): Promise<void>;
  pending(): Promise<PendingEvent[]>;
  subscribeOutcomes?: (
    listener: (outcome: OutboxOutcome) => void,
  ) => () => void;
}

export interface DialConfirmation {
  isCurrent(): boolean;
  accepted(): void;
  rejected(message: string): void;
}

/** Подписка до enqueue: его завершение ещё не подтверждает принятие звонка сервером. */
export function confirmDial(
  client: DialClient,
  cardId: string,
  event: CardEvent,
  confirmation: DialConfirmation,
): { queued: Promise<void>; dispose: () => void } {
  let disposed = false;
  let settled = false;
  const dispose = () => {
    disposed = true;
    unsubscribe?.();
  };
  const finish = (failure?: string) => {
    if (disposed || settled) return;
    settled = true;
    dispose();
    if (!confirmation.isCurrent()) return;
    if (failure !== undefined) confirmation.rejected(failure);
    else confirmation.accepted();
  };
  const unsubscribe = client.subscribeOutcomes?.((outcome) => {
    if (
      outcome.item.cardId !== cardId ||
      outcome.item.id !== event.client_event_id ||
      outcome.item.event.type !== event.type ||
      !("call_id" in outcome.item.event.payload) ||
      !("call_id" in event.payload) ||
      outcome.item.event.payload.call_id !== event.payload.call_id
    )
      return;
    finish(
      outcome.status === "rejected"
        ? (outcome.message ??
            (outcome.code === "line_busy"
              ? "Линия занята."
              : "Не удалось набрать номер. Повторите звонок."))
        : undefined,
    );
  });
  const queued = (async () => {
    try {
      await client.enqueue(cardId, event);
      if (disposed || settled || !confirmation.isCurrent()) return;
      const pending = await client.pending();
      if (disposed || settled || !confirmation.isCurrent()) return;
      const dial = pending.find(
        (item) => item.cardId === cardId && item.id === event.client_event_id,
      );
      if (dial?.failure) finish(dial.failure);
      // Для старых клиентов без подписки проверяем сам набор, а не только ошибки:
      // без сети или за отклонённым действием он остаётся в очереди.
      else if (!client.subscribeOutcomes && !dial) finish();
    } catch {
      finish("Не удалось набрать номер. Повторите звонок.");
    }
  })();
  return { queued, dispose };
}
