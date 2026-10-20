import { describe, expect, it } from "vitest";
import type { PendingEvent } from "../shared/ws/outbox";
import { noticeItems, STUCK_AFTER_MS } from "./outboxNotice";

const NOW = 1_000_000;
const item = (
  id: string,
  ageMs: number,
  extra: Partial<PendingEvent> = {},
): PendingEvent => ({
  id,
  userId: "u",
  cardId: "c",
  event: {
    type: "call_answer",
    client_event_id: id,
    payload: { call_id: "x" },
  } as unknown as PendingEvent["event"],
  queuedAt: NOW - ageMs,
  sequence: 1,
  ...extra,
});

describe("плашка очереди действий", () => {
  it("действие в пути (доли секунды) — плашки нет", () => {
    // Проверка капитана 20.10: «ответ абонента — ожидает отправки» в начале разговора.
    expect(noticeItems([item("a", 100)], NOW)).toEqual([]);
    expect(noticeItems([item("a", STUCK_AFTER_MS - 1)], NOW)).toEqual([]);
  });

  it("не уходит дольше порога — показываем только застрявшее", () => {
    const stuck = item("a", STUCK_AFTER_MS);
    expect(noticeItems([stuck, item("b", 200)], NOW)).toEqual([stuck]);
  });

  it("сервер отклонил — сразу вся очередь: она остановлена", () => {
    const failed = item("a", 50, { failure: "Событие отклонено сервером." });
    const next = item("b", 10);
    expect(noticeItems([failed, next], NOW)).toEqual([failed, next]);
  });
});
