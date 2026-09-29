import { openDB, type DBSchema } from "idb";
import type { CardEvent } from "../api";

export interface PendingEvent {
  id: string;
  userId: string;
  cardId: string;
  event: CardEvent;
  queuedAt: number;
  sequence: number;
  failure?: string;
}

interface OutboxSchema extends DBSchema {
  events: { key: string; value: PendingEvent };
  counters: { key: string; value: number };
}

export class Outbox {
  private database;

  constructor(name = "arm112-outbox-v1") {
    this.database = openDB<OutboxSchema>(name, 2, {
      async upgrade(db, _oldVersion, _newVersion, transaction) {
        if (!db.objectStoreNames.contains("events"))
          db.createObjectStore("events", { keyPath: "id" });
        if (!db.objectStoreNames.contains("counters"))
          db.createObjectStore("counters");
        const events = transaction.objectStore("events");
        const counters = transaction.objectStore("counters");
        const items = await events.getAll();
        const legacy = items.some((item) => !Number.isFinite(item.sequence));
        // В раннем v1 не было sequence. Восстанавливаем порядок по queuedAt;
        // для одинакового времени исходный порядок уже невозможно узнать.
        items.sort((a, b) =>
          legacy ? a.queuedAt - b.queuedAt : a.sequence - b.sequence,
        );
        let sequence = (await counters.get("sequence")) ?? 0;
        for (const item of items) {
          if (legacy) await events.put({ ...item, sequence: ++sequence });
          else sequence = Math.max(sequence, item.sequence);
        }
        await counters.put(sequence, "sequence");
      },
      blocking: () => {
        // Не блокируем обновление схемы другой вкладкой новой версии приложения.
        void this.close();
      },
    });
  }

  async add(userId: string, cardId: string, event: CardEvent): Promise<void> {
    const db = await this.database;
    const transaction = db.transaction(["events", "counters"], "readwrite");
    const existing = await transaction
      .objectStore("events")
      .get(event.client_event_id);
    if (existing) {
      if (
        existing.userId !== userId ||
        existing.cardId !== cardId ||
        JSON.stringify(existing.event) !== JSON.stringify(event)
      ) {
        transaction.abort();
        await transaction.done.catch(() => undefined);
        throw new Error("client_event_id уже используется другим действием.");
      }
      await transaction.done;
      return;
    }
    const sequence =
      ((await transaction.objectStore("counters").get("sequence")) ?? 0) + 1;
    await transaction.objectStore("counters").put(sequence, "sequence");
    await transaction.objectStore("events").put({
      id: event.client_event_id,
      userId,
      cardId,
      event,
      queuedAt: Date.now(),
      sequence,
    });
    await transaction.done;
  }

  async list(userId: string): Promise<PendingEvent[]> {
    const db = await this.database;
    return (await db.getAll("events"))
      .filter((item) => item.userId === userId)
      .sort((a, b) => a.sequence - b.sequence);
  }

  async remove(id: string): Promise<void> {
    await (await this.database).delete("events", id);
  }
  async fail(item: PendingEvent, failure: string): Promise<void> {
    await (await this.database).put("events", { ...item, failure });
  }
  async discardBlockedCard(userId: string, cardId: string): Promise<number> {
    const db = await this.database;
    const transaction = db.transaction("events", "readwrite");
    const events = transaction.objectStore("events");
    const items = (await events.getAll()).filter(
      (item) => item.userId === userId && item.cardId === cardId,
    );
    // Удаление требует явного решения обучаемого: поздние действия могли зависеть
    // от отклонённого статуса и автоматически отправлять их уже нельзя.
    if (items.some((item) => item.failure))
      for (const item of items) await events.delete(item.id);
    await transaction.done;
    return items.some((item) => item.failure) ? items.length : 0;
  }
  async close(): Promise<void> {
    (await this.database).close();
  }
}

export async function flushOutbox(
  outbox: Outbox,
  userId: string,
  send: (
    item: PendingEvent,
  ) => Promise<{ status: number; message?: string; code?: string }>,
): Promise<void> {
  const blockedCards = new Set<string>();
  for (const item of await outbox.list(userId)) {
    // list уже изолирован по пользователю; отказ блокирует только свою карточку.
    if (item.failure) blockedCards.add(item.cardId);
    if (blockedCards.has(item.cardId)) continue;
    let result;
    try {
      result = await send(item);
    } catch {
      break;
    }
    // Повтор deliver после reload: сервер уже учёл доставку, карточку не блокируем.
    const alreadyDelivered =
      item.event.type === "deliver" &&
      result.status === 409 &&
      result.code === "card_already_delivered";
    if ((result.status >= 200 && result.status < 300) || alreadyDelivered)
      await outbox.remove(item.id);
    else if (result.status === 401 || result.status >= 500) break;
    else {
      await outbox.fail(item, result.message ?? "Событие отклонено сервером.");
      blockedCards.add(item.cardId);
    }
  }
}

/**
 * Отправка очереди без наложений и без потерь. Вызов во время идущей отправки
 * не пропускается: по её окончании отправка запускается ещё раз и подхватывает
 * события, добавленные в очередь уже после того, как текущий проход взял список.
 * Без этого новое действие ждало ближайшего heartbeat — до 5 с (выяснено по
 * нестабильному e2e session-isolation; исправлено Dwots с разрешения капитана).
 */
export function coalesce(run: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await run();
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  };
}
