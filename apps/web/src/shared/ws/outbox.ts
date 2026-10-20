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

/** Локальный результат HTTP/очереди после сохранения, не событие протокола WS. */
export interface OutboxOutcome {
  item: PendingEvent;
  status: "accepted" | "rejected";
  code?: string;
  message?: string;
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
    // Старый outbox записывал failure только после окончательного HTTP-отказа
    // (401 и 5xx оставались неопределёнными). Реплика и ACK не создают зависимостей.
    // Убираем именно такие исторические отказы до discovery и blockedCards.
    const transaction = db.transaction("events", "readwrite");
    const store = transaction.objectStore("events");
    const items = await store.getAll();
    const terminal = (item: PendingEvent) =>
      item.userId === userId &&
      (item.event.type === "brigade_said" ||
        item.event.type === "report_confirmed") &&
      !!item.failure;
    for (const item of items) if (terminal(item)) await store.delete(item.id);
    await transaction.done;
    return items
      .filter((item) => item.userId === userId && !terminal(item))
      .sort((a, b) => a.sequence - b.sequence);
  }

  async has(id: string): Promise<boolean> {
    return (await (await this.database).get("events", id)) !== undefined;
  }

  /** Подтверждённый отказ набора отменяет только этот звонок, но не всю карточку. */
  async discardCall(dial: PendingEvent, callId: string): Promise<void> {
    const db = await this.database;
    const transaction = db.transaction("events", "readwrite");
    const events = transaction.objectStore("events");
    for (const item of await events.getAll()) {
      if (
        item.userId === dial.userId &&
        item.cardId === dial.cardId &&
        (item.id === dial.id ||
          (item.sequence > dial.sequence &&
            "call_id" in item.event.payload &&
            item.event.payload.call_id === callId))
      )
        await events.delete(item.id);
    }
    await transaction.done;
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
  outcome: (result: OutboxOutcome) => void = () => {},
): Promise<void> {
  const blockedCards = new Set<string>();
  for (const item of await outbox.list(userId)) {
    // Отказ предыдущего набора мог удалить зависимые действия из этого снимка очереди.
    if (!(await outbox.has(item.id))) continue;
    // list уже изолирован по пользователю; отказ блокирует только свою карточку.
    if (item.failure) blockedCards.add(item.cardId);
    if (blockedCards.has(item.cardId)) continue;
    let result;
    try {
      result = await send(item);
    } catch {
      break;
    }
    if (
      item.event.type === "call_dial_target" &&
      result.status === 409 &&
      result.code === "line_busy"
    ) {
      await outbox.discardCall(item, item.event.payload.call_id);
      outcome({
        item,
        status: "rejected",
        code: result.code,
        message: result.message,
      });
      continue;
    }
    // Отказ на ответ не даёт владения линией, в том числе при call_ended. Удаляем
    // зависимые действия звонка, сохраняя чужие звонки и статусы карточки.
    if (
      item.event.type === "call_answer" &&
      result.status >= 400 &&
      result.status < 500 &&
      result.status !== 401
    ) {
      await outbox.discardCall(item, item.event.payload.call_id);
      outcome({
        item,
        status: "rejected",
        code: result.code,
        message: result.message,
      });
      continue;
    }
    // Повтор deliver после reload: сервер уже учёл доставку, карточку не блокируем.
    const alreadyDelivered =
      item.event.type === "deliver" &&
      result.status === 409 &&
      result.code === "card_already_delivered";
    // Ответ или отбой одновременно с тем, как сервер погасил вызов бригады (пропущенный,
    // TC-02): звонка уже нет, ждать нечего — карточку из-за гонки не блокируем.
    const callEnded =
      item.event.type === "call_hangup" &&
      result.status === 409 &&
      result.code === "call_ended";
    // Отметка удержания (HQ-033) нужна только разбору: не сошлась с журналом (звонок уже
    // кончился, повтор после обновления страницы) — карточку не блокируем.
    const holdMark =
      (item.event.type === "call_hold" || item.event.type === "call_resume") &&
      result.status === 409 &&
      (result.code === "call_ended" || result.code === "hold_state");
    // Реплика заявителя (HQ-019) нужна оценке и разбору: звонок оказался не заявителю
    // (настройки занятия сменились) или фразы нет — карточку не блокируем.
    const callerMark =
      item.event.type === "caller_said" &&
      ((result.status === 409 && result.code === "caller_line") ||
        result.status === 404 ||
        result.status === 422);
    if (
      (result.status >= 200 && result.status < 300) ||
      alreadyDelivered ||
      callEnded ||
      holdMark ||
      callerMark
    ) {
      await outbox.remove(item.id);
      outcome({ item, status: "accepted", code: result.code });
    } else if (result.status === 401 || result.status >= 500) break;
    else {
      // Отклонённая реплика или ACK не меняют состояние звонка. Удаляем только
      // её: иначе исправленный ручной ответ навсегда застрянет за старым отказом.
      if (
        item.event.type === "brigade_said" ||
        item.event.type === "report_confirmed"
      )
        await outbox.remove(item.id);
      else {
        await outbox.fail(
          item,
          result.message ?? "Событие отклонено сервером.",
        );
        blockedCards.add(item.cardId);
      }
      outcome({
        item,
        status: "rejected",
        code: result.code,
        message: result.message,
      });
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
