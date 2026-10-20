import type { CardEvent } from "../../shared/api";
import type { OutboxOutcome, PendingEvent } from "../../shared/ws/outbox";

type NewsEvent = Extract<CardEvent, { type: "brigade_said" }>;
interface NewsClient {
  enqueue(cardId: string, event: CardEvent): Promise<void>;
  pending(): Promise<PendingEvent[]>;
  subscribeOutcomes?: (
    listener: (outcome: OutboxOutcome) => void,
  ) => () => void;
}

/** Локальное принятие, запись в outbox и ответ сервера — три разных состояния. */
export function deliverServiceNews(
  client: NewsClient,
  cardId: string,
  event: NewsEvent,
  callbacks: {
    current(): boolean;
    accepted(): void;
    rejected(): void;
    confirmed?(): Promise<boolean>;
    cachedConfirmed?(): boolean | undefined;
    identity?: string;
    storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  },
): () => void {
  // Сохраняем сам исходный envelope: повтор после ACK-loss использует тот же
  // client_event_id и payload, даже если новый владелец уже разговаривает по другому call_id.
  const storage =
    callbacks.storage ??
    (typeof localStorage === "undefined" ? undefined : localStorage);
  const storageKey = callbacks.identity
    ? `arm112-service-news:${callbacks.identity}`
    : null;
  let tracked = event.client_event_id;
  let disposed = false;
  let settled = false;
  const observed = new Map<string, OutboxOutcome>();
  const subscription: { dispose?: () => void } = {};
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    subscription.dispose?.();
  };
  let resolving = false;
  const finish = (accepted: boolean, reconciled = false) => {
    if (disposed || settled || resolving) return;
    resolving = true;
    void (async () => {
      let confirmed = accepted;
      while (!disposed && accepted && !reconciled && callbacks.confirmed) {
        try {
          confirmed = await callbacks.confirmed();
          break;
        } catch {
          // ACK без доступного readback остаётся неопределённым, не успехом.
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
      }
      if (disposed || settled) return;
      settled = true;
      if (storageKey && storage) {
        try {
          storage.removeItem(storageKey);
        } catch {
          // Неудачная очистка не отменяет исход. Сохраняем его вместе с исходным
          // envelope, чтобы remount не создал новую операцию из старой записи.
          try {
            storage.setItem(storageKey, JSON.stringify({ event, confirmed }));
          } catch {
            // Если запись тоже недоступна, исходный envelope остаётся для readback.
          }
        }
      }
      dispose();
      if (confirmed) callbacks.accepted();
      else callbacks.rejected();
    })();
  };
  subscription.dispose = client.subscribeOutcomes?.((outcome) => {
    if (
      outcome.item.cardId !== cardId ||
      outcome.item.event.type !== "brigade_said" ||
      (!callbacks.identity &&
        (outcome.item.event.payload.call_id !== event.payload.call_id ||
          outcome.item.event.payload.text !== event.payload.text))
    )
      return;
    observed.set(outcome.item.id, outcome);
    if (outcome.item.id === tracked) finish(outcome.status === "accepted");
  });
  const readPending = async () => {
    while (!disposed && !settled) {
      try {
        return await client.pending();
      } catch {
        // Ошибка чтения не доказывает отсутствия записи. Повторяем только чтение.
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
    }
    return [];
  };
  const discover = async () => {
    try {
      // После remount не дублируем неопределённую реплику из долговечной очереди.
      const pending = await readPending();
      if (disposed || settled) return;
      let restored = false;
      if (storageKey && storage) {
        const raw = storage.getItem(storageKey);
        if (raw) {
          const saved = JSON.parse(raw) as
            | NewsEvent
            | { event: NewsEvent; confirmed: boolean };
          restored = true;
          event = "event" in saved ? saved.event : saved;
          tracked = event.client_event_id;
          if ("event" in saved) {
            finish(saved.confirmed, true);
            return;
          }
        }
      }
      const cached = !restored ? callbacks.cachedConfirmed?.() : undefined;
      if (
        cached === true ||
        (cached === undefined &&
          callbacks.confirmed &&
          (await callbacks.confirmed()))
      ) {
        finish(true);
        return;
      }
      if (disposed || settled) return;
      const existing = pending.find(
        (item) =>
          item.cardId === cardId &&
          (!callbacks.identity || item.id === tracked) &&
          item.event.type === "brigade_said" &&
          item.event.payload.call_id === event.payload.call_id &&
          item.event.payload.text === event.payload.text,
      );
      if (existing) {
        tracked = existing.id;
        const outcome = observed.get(tracked);
        if (outcome) finish(outcome.status === "accepted");
        else if (existing.failure) finish(false);
        return;
      }
      // Replay мог завершиться, пока читалась очередь: отсутствие записи не ACK,
      // но полученный точный outcome нельзя потерять или послать дубль вслед за ним.
      const completed = callbacks.identity
        ? observed.get(tracked)
        : observed.values().next().value;
      if (completed) {
        finish(completed.status === "accepted");
        return;
      }
      if (!callbacks.current()) {
        finish(false);
        return;
      }
      try {
        if (storageKey && storage)
          storage.setItem(storageKey, JSON.stringify(event));
        await client.enqueue(cardId, event);
      } catch {
        // Отказ enqueue ещё не доказывает отказ записи: flush мог упасть после add.
        const queued = (await readPending()).find(
          (item) => item.cardId === cardId && item.id === tracked,
        );
        if (!queued || queued.failure) finish(false);
      }
      // Успешный enqueue без outcome остаётся pending, а не превращается в ACK.
    } catch {
      // Нельзя разблокировать или послать повтор без подтверждённого чтения.
      if (!disposed && !settled)
        setTimeout(() => {
          void discover();
        }, 100);
    }
  };
  void discover();
  return dispose;
}
