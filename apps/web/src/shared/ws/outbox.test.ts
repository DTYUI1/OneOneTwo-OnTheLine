import "fake-indexeddb/auto";
import { openDB } from "idb";
import { describe, expect, it, vi } from "vitest";
import { flushOutbox, Outbox, type PendingEvent, coalesce } from "./outbox";
import { clockOffset, isServerEvent } from "./client";
import type { CardEvent } from "../api";

const event = (): CardEvent => ({
  client_event_id: crypto.randomUUID(),
  client_ts: new Date().toISOString(),
  type: "open",
  payload: {},
});
const deliverEvent = (): CardEvent => ({
  client_event_id: crypto.randomUUID(),
  client_ts: new Date().toISOString(),
  type: "deliver",
  payload: {},
});

describe("Часы v2", () => {
  it("принимает clock.pong.v2 из контракта WS", () => {
    expect(
      isServerEvent({
        schema_version: 1,
        event_id: crypto.randomUUID(),
        server_ts: "2026-09-25T00:00:01.000Z",
        type: "clock.pong.v2",
        payload: {
          sample_id: crypto.randomUUID(),
          client_ts: "2026-09-25T00:00:00.900Z",
        },
      }),
    ).toBe(true);
  });
});

describe("Очередь действий", () => {
  it("обновляет старую базу без counters, сохраняя события и порядок", async () => {
    const name = crypto.randomUUID();
    const legacy = await openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore("events", { keyPath: "id" });
      },
    });
    const first = event();
    const second = event();
    for (const [action, queuedAt] of [
      [second, 2000],
      [first, 1000],
    ] as const) {
      await legacy.put("events", {
        id: action.client_event_id,
        userId: "user",
        cardId: "card",
        event: action,
        queuedAt,
        failure: action === first ? "Конфликт" : undefined,
      });
    }
    legacy.close();
    const restored = new Outbox(name);
    try {
      const third = event();
      await restored.add("user", "card", third);
      const items = await restored.list("user");
      expect(items.map((item) => item.event)).toEqual([first, second, third]);
      expect(items.map((item) => item.sequence)).toEqual([1, 2, 3]);
      expect(items[0].failure).toBe("Конфликт");
    } finally {
      await restored.close();
    }
  });

  it("обновляет текущую v1 и продолжает sequence после уже отправленных событий", async () => {
    const name = crypto.randomUUID();
    const legacy = await openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore("events", { keyPath: "id" });
        db.createObjectStore("counters");
      },
    });
    await legacy.put("counters", 42, "sequence");
    legacy.close();
    const restored = new Outbox(name);
    try {
      await restored.add("user", "card", event());
      expect((await restored.list("user"))[0].sequence).toBe(43);
    } finally {
      await restored.close();
    }
  });

  it("сохраняет порядок действий в одну миллисекунду", async () => {
    const outbox = new Outbox(crypto.randomUUID());
    const fixedClock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const first = {
      ...event(),
      client_event_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    };
    const second = {
      ...event(),
      client_event_id: "00000000-0000-4000-8000-000000000000",
    };
    try {
      await outbox.add("user", "card", first);
      await outbox.add("user", "card", second);
      expect((await outbox.list("user")).map((item) => item.event)).toEqual([
        first,
        second,
      ]);
    } finally {
      fixedClock.mockRestore();
      await outbox.close();
    }
  });
  it("переживает перезагрузку и не отдаёт события другого пользователя", async () => {
    const name = crypto.randomUUID();
    const first = new Outbox(name);
    const action = event();
    await first.add("user-1", "card-1", action);
    await first.close();
    const restored = new Outbox(name);
    expect(await restored.list("user-2")).toEqual([]);
    expect((await restored.list("user-1"))[0].event).toEqual(action);
    await restored.close();
  });
  it("сохраняет событие при обрыве и удаляет только после ACK", async () => {
    const outbox = new Outbox(crypto.randomUUID());
    const action = event();
    await outbox.add("user", "card", action);
    await flushOutbox(outbox, "user", async () => {
      throw new Error("offline");
    });
    expect(await outbox.list("user")).toHaveLength(1);
    await flushOutbox(outbox, "user", async (item) => {
      expect(item.event.client_event_id).toBe(action.client_event_id);
      return { status: 200 };
    });
    expect(await outbox.list("user")).toHaveLength(0);
    await outbox.close();
  });
  it("не удаляет конфликт и не обгоняет его следующими действиями", async () => {
    const outbox = new Outbox(crypto.randomUUID());
    await outbox.add("user", "card", event());
    await outbox.add("user", "card", event());
    let sent = 0;
    await flushOutbox(outbox, "user", async () => {
      sent++;
      return { status: 409 };
    });
    expect(sent).toBe(1);
    expect(await outbox.list("user")).toHaveLength(2);
    expect((await outbox.list("user"))[0].failure).toBeTruthy();
    await outbox.close();
  });
  it("после явной очистки отказа повторные действия карточки снова отправляются", async () => {
    const outbox = new Outbox(crypto.randomUUID());
    const rejected = event();
    const dependent = event();
    const other = event();
    await outbox.add("user", "card", rejected);
    await outbox.add("user", "card", dependent);
    await outbox.add("user", "other", other);
    await flushOutbox(outbox, "user", async (item) =>
      item.cardId === "card"
        ? { status: 422, message: "Недопустимый статус" }
        : { status: 200 },
    );
    expect((await outbox.list("user")).map((item) => item.event)).toEqual([
      rejected,
      dependent,
    ]);
    expect(await outbox.discardBlockedCard("user", "other")).toBe(0);
    expect(await outbox.discardBlockedCard("another", "card")).toBe(0);
    expect(await outbox.discardBlockedCard("user", "card")).toBe(2);
    const retry = event();
    await outbox.add("user", "card", retry);
    const sent: string[] = [];
    await flushOutbox(outbox, "user", async (item) => {
      sent.push(item.id);
      return { status: 200 };
    });
    expect(sent).toEqual([retry.client_event_id]);
    expect(await outbox.list("user")).toEqual([]);
    await outbox.close();
  });
  it("повторный deliver после reload не блокирует open той же карточки", async () => {
    const outbox = new Outbox(crypto.randomUUID());
    const deliver = deliverEvent();
    const open = event();
    await outbox.add("user", "card", deliver);
    await outbox.add("user", "card", open);
    const sent: string[] = [];
    await flushOutbox(outbox, "user", async (item) => {
      sent.push(item.event.type);
      return item.event.type === "deliver"
        ? { status: 409, code: "card_already_delivered" }
        : { status: 200 };
    });
    expect(sent).toEqual(["deliver", "open"]);
    expect(await outbox.list("user")).toEqual([]);
    await outbox.close();
  });
  it("иной конфликт deliver по-прежнему сохраняется как отказ", async () => {
    const outbox = new Outbox(crypto.randomUUID());
    await outbox.add("user", "card", deliverEvent());
    await flushOutbox(outbox, "user", async () => ({
      status: 409,
      code: "session_finished",
    }));
    expect((await outbox.list("user"))[0].failure).toBeTruthy();
    await outbox.close();
  });
  it("при 401 ждёт восстановления сессии", async () => {
    const outbox = new Outbox(crypto.randomUUID());
    await outbox.add("user", "card", event());
    await flushOutbox(outbox, "user", async () => ({ status: 401 }));
    expect((await outbox.list("user"))[0].failure).toBeUndefined();
    await outbox.close();
  });
  it("изолирует отказ карточки, сохраняет доказательства и порядок после reload", async () => {
    const name = crypto.randomUUID();
    const outbox = new Outbox(name);
    const actions = Array.from({ length: 5 }, event);
    await outbox.add("user", "old", actions[0]);
    await outbox.add("user", "new", actions[1]);
    await outbox.add("user", "old", actions[2]);
    await outbox.add("other", "new", actions[3]);
    await outbox.add("user", "new", actions[4]);
    const before = await outbox.list("user");
    const send = vi.fn(async (item: PendingEvent) => ({
      status: item.cardId === "old" ? 409 : 200,
      message: "Занятие завершено.",
    }));
    await flushOutbox(outbox, "user", send);
    expect(send.mock.calls.map(([item]) => item.event)).toEqual([
      actions[0],
      actions[1],
      actions[4],
    ]);
    const retained = [
      { ...before[0], failure: "Занятие завершено." },
      before[2],
    ];
    expect(await outbox.list("user")).toEqual(retained);
    await outbox.close();
    const restored = new Outbox(name);
    try {
      await restored.add("user", "old", actions[0]);
      const next = event();
      await restored.add("user", "new", next);
      send.mockClear();
      await flushOutbox(restored, "user", send);
      expect(send.mock.calls.map(([item]) => item.event)).toEqual([next]);
      expect(await restored.list("user")).toEqual(retained);
      expect((await restored.list("other"))[0].event).toEqual(actions[3]);
    } finally {
      await restored.close();
    }
  });
  it.each([401, 500, 503, "network"])(
    "при временном отказе %s ждёт восстановления всей отправки",
    async (status) => {
      const outbox = new Outbox(crypto.randomUUID());
      try {
        await outbox.add("user", "first", event());
        await outbox.add("user", "second", event());
        const before = await outbox.list("user");
        const send = vi.fn(async () => {
          if (status === "network") throw new Error("offline");
          return { status: status as number };
        });
        await flushOutbox(outbox, "user", send);
        expect(send).toHaveBeenCalledTimes(1);
        expect(await outbox.list("user")).toEqual(before);
        const retry = vi.fn(async () => ({ status: 200 }));
        await flushOutbox(outbox, "user", retry);
        expect(retry.mock.calls).toHaveLength(2);
        expect(await outbox.list("user")).toEqual([]);
      } finally {
        await outbox.close();
      }
    },
  );
});
it("измеряет оффсет с учётом половины RTT", () => {
  expect(clockOffset(1000, 1200, 1600)).toBe(500);
});
it("отклоняет неизвестные WS-конверты", () => {
  expect(isServerEvent({ type: "unknown" })).toBe(false);
  expect(isServerEvent(null)).toBe(false);
});

describe("coalesce: отправка очереди без потерь", () => {
  it("вызов во время идущей отправки запускает ещё один проход", async () => {
    let calls = 0;
    let release!: () => void;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const flush = coalesce(async () => {
      calls += 1;
      if (calls === 1) await first; // идёт отправка — например, медленный deliver
    });
    const running = flush();
    const late = flush(); // событие open поставлено во время отправки
    expect(calls).toBe(1);
    release();
    await Promise.all([running, late]);
    // Без повтора open ждал бы ближайшего heartbeat (до 5 с).
    expect(calls).toBe(2);
  });

  it("не накладывает проходы и сворачивает несколько поздних вызовов в один", async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const flush = coalesce(async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (calls === 1) await gate;
      active -= 1;
    });
    const all = [flush(), flush(), flush(), flush()];
    release();
    await Promise.all(all);
    expect(maxActive).toBe(1);
    expect(calls).toBe(2);
  });

  it("после завершения следующий вызов стартует заново", async () => {
    let calls = 0;
    const flush = coalesce(async () => {
      calls += 1;
    });
    await flush();
    await flush();
    expect(calls).toBe(2);
  });

  it("ошибка прохода не оставляет очередь «занятой»", async () => {
    let calls = 0;
    const flush = coalesce(async () => {
      calls += 1;
      if (calls === 1) throw new Error("сеть");
    });
    await expect(flush()).rejects.toThrow("сеть");
    await flush();
    expect(calls).toBe(2);
  });
});
