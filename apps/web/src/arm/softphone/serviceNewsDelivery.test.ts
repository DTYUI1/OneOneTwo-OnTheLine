import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import {
  flushOutbox,
  Outbox,
  type OutboxOutcome,
} from "../../shared/ws/outbox";
import type { CardEvent } from "../../shared/api";
import { deliverServiceNews } from "./serviceNewsDelivery";

const news = (): CardEvent => ({
  client_event_id: crypto.randomUUID(),
  client_ts: new Date().toISOString(),
  type: "brigade_said",
  payload: { call_id: "call", text: "Служба вызвана." },
});

it("terminal brigade_said rejection permits real outbox retry without discarding other actions", async () => {
  const box = new Outbox(crypto.randomUUID());
  try {
    const first = news();
    await box.add("user", "card", first);
    await box.add("other", "card", news());
    const outcomes: OutboxOutcome[] = [];
    await flushOutbox(
      box,
      "user",
      async () => ({ status: 422 }),
      (item) => outcomes.push(item),
    );
    expect(outcomes).toMatchObject([
      { status: "rejected", item: { id: first.client_event_id } },
    ]);
    expect(await box.list("user")).toEqual([]);
    expect(await box.list("other")).toHaveLength(1);
    await box.add("user", "card", news());
    const send = vi.fn(async () => ({ status: 200 }));
    await flushOutbox(box, "user", send);
    expect(send).toHaveBeenCalledOnce();
    expect(await box.list("user")).toEqual([]);
  } finally {
    await box.close();
  }
});
it.each([401, 503])(
  "uncertain brigade_said status %s remains durable",
  async (status) => {
    const box = new Outbox(crypto.randomUUID());
    try {
      await box.add("user", "card", news());
      const outcomes = vi.fn();
      await flushOutbox(box, "user", async () => ({ status }), outcomes);
      expect(outcomes).not.toHaveBeenCalled();
      expect(await box.list("user")).toHaveLength(1);
    } finally {
      await box.close();
    }
  },
);

it("durable uncertainty survives a new owner and ignores unrelated outcomes", async () => {
  const box = new Outbox(crypto.randomUUID());
  const listeners = new Set<(outcome: OutboxOutcome) => void>();
  const emit = (outcome: OutboxOutcome) => {
    for (const listener of listeners) listener(outcome);
  };
  const client = {
    pending: vi.fn(() => box.list("user")),
    subscribeOutcomes: (listener: (outcome: OutboxOutcome) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    enqueue: vi.fn(async (cardId: string, event: CardEvent) => {
      await box.add("user", cardId, event);
      await flushOutbox(
        box,
        "user",
        async () => {
          throw new Error("response lost");
        },
        emit,
      );
    }),
  };
  const first = { current: () => true, accepted: vi.fn(), rejected: vi.fn() };
  const second = { current: () => true, accepted: vi.fn(), rejected: vi.fn() };
  let dispose = () => {};
  try {
    const original = news();
    if (original.type !== "brigade_said") throw new Error("fixture");
    dispose = deliverServiceNews(client, "card", original, first);
    await vi.waitFor(async () =>
      expect(await box.list("user")).toHaveLength(1),
    );
    dispose();
    const retry = news();
    if (retry.type !== "brigade_said") throw new Error("fixture");
    dispose = deliverServiceNews(client, "card", retry, second);
    await client.pending.mock.results.at(-1)!.value;
    expect(client.enqueue).toHaveBeenCalledOnce();
    const item = (await box.list("user"))[0];
    emit({ status: "rejected", item: { ...item, cardId: "another" } });
    emit({
      status: "accepted",
      item: {
        ...item,
        event: {
          ...original,
          payload: { ...original.payload, call_id: "another" },
        },
      },
    });
    expect(second.accepted).not.toHaveBeenCalled();
    expect(second.rejected).not.toHaveBeenCalled();
    await flushOutbox(box, "user", async () => ({ status: 200 }), emit);
    expect(second.accepted).toHaveBeenCalledOnce();
    expect(first.accepted).not.toHaveBeenCalled();
    expect(first.rejected).not.toHaveBeenCalled();
    expect(await box.list("user")).toEqual([]);
  } finally {
    dispose();
    await box.close();
  }
});

it.each(["accepted", "rejected"] as const)(
  "outcome during durable discovery is not lost: %s",
  async (status) => {
    const old = news();
    const next = news();
    if (old.type !== "brigade_said" || next.type !== "brigade_said")
      throw new Error("fixture");
    const item = {
      id: old.client_event_id,
      userId: "user",
      cardId: "card",
      event: old,
      queuedAt: 0,
      sequence: 1,
    };
    let resolve!: (
      items: import("../../shared/ws/outbox").PendingEvent[],
    ) => void;
    let listener!: (outcome: OutboxOutcome) => void;
    const client = {
      pending: () =>
        new Promise<import("../../shared/ws/outbox").PendingEvent[]>((r) => {
          resolve = r;
        }),
      subscribeOutcomes: (fn: typeof listener) => {
        listener = fn;
        return () => {};
      },
      enqueue: vi.fn(async () => {}),
    };
    const callbacks = {
      current: () => true,
      accepted: vi.fn(),
      rejected: vi.fn(),
    };
    const dispose = deliverServiceNews(client, "card", next, callbacks);
    try {
      listener({ status, item });
      resolve([item]);
      await vi.waitFor(() => expect(callbacks[status]).toHaveBeenCalledOnce());
      expect(client.enqueue).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  },
);

it("pending discovery retries a transient read failure without unlocking uncertainty", async () => {
  const event = news();
  if (event.type !== "brigade_said") throw new Error("fixture");
  const client = {
    pending: vi
      .fn()
      .mockRejectedValueOnce(new Error("read unavailable"))
      .mockResolvedValue([]),
    enqueue: vi.fn(async () => {}),
  };
  const callbacks = {
    current: () => true,
    accepted: vi.fn(),
    rejected: vi.fn(),
  };
  const dispose = deliverServiceNews(client, "card", event, callbacks);
  try {
    await vi.waitFor(() => expect(client.enqueue).toHaveBeenCalledOnce(), {
      timeout: 1500,
    });
    expect(client.pending).toHaveBeenCalledTimes(2);
    expect(callbacks.rejected).not.toHaveBeenCalled();
  } finally {
    dispose();
  }
});

it("legacy terminal brigade_said failure is removed before discovery and card blocking", async () => {
  const box = new Outbox(crypto.randomUUID());
  try {
    const old = news();
    await box.add("user", "card", old);
    const [item] = await box.list("user");
    await box.fail(item, "Событие отклонено сервером.");
    const next = news();
    await box.add("user", "card", next);
    await box.add("other", "card", news());
    const status: CardEvent = {
      client_event_id: crypto.randomUUID(),
      client_ts: new Date().toISOString(),
      type: "status_change",
      payload: { state: "accepted", comment: "" },
    };
    await box.add("user", "another", status);
    const unrelated = (await box.list("user")).find(
      (row) => row.cardId === "another",
    )!;
    await box.fail(unrelated, "Событие отклонено сервером.");
    expect((await box.list("user")).map((row) => row.id)).not.toContain(
      old.client_event_id,
    );
    const sent: string[] = [];
    const send = vi.fn(
      async (item: import("../../shared/ws/outbox").PendingEvent) => {
        sent.push(item.id);
        return { status: 200 };
      },
    );
    await flushOutbox(box, "user", send);
    expect(send).toHaveBeenCalledOnce();
    expect(sent).toEqual([next.client_event_id]);
    expect(await box.list("other")).toHaveLength(1);
    expect(await box.list("user")).toMatchObject([
      { id: status.client_event_id, failure: "Событие отклонено сервером." },
    ]);
  } finally {
    await box.close();
  }
});

it.each(["pending", "completion-during-discovery"])(
  "distinct identities in the same call never adopt another request: %s",
  async (mode) => {
    const box = new Outbox(crypto.randomUUID());
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    const listeners = new Set<(outcome: OutboxOutcome) => void>();
    let release!: (
      items: import("../../shared/ws/outbox").PendingEvent[],
    ) => void;
    const client = {
      pending: vi.fn(() => box.list("user")),
      enqueue: vi.fn(async (cardId: string, event: CardEvent) => {
        await box.add("user", cardId, event);
      }),
      subscribeOutcomes: (listener: (outcome: OutboxOutcome) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const callbacks = (identity: string) => ({
      identity,
      storage,
      current: () => true,
      accepted: vi.fn(),
      rejected: vi.fn(),
    });
    const d1 = callbacks("card/brigade/D1");
    const d2 = callbacks("card/brigade/D2");
    const original = news();
    const next = news();
    if (original.type !== "brigade_said" || next.type !== "brigade_said")
      throw new Error("fixture");
    const dispose1 = deliverServiceNews(client, "card", original, d1);
    let dispose2 = () => {};
    try {
      await vi.waitFor(() => expect(client.enqueue).toHaveBeenCalledOnce());
      const [item1] = await box.list("user");
      if (mode === "completion-during-discovery")
        client.pending.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              release = resolve;
            }),
        );
      dispose2 = deliverServiceNews(client, "card", next, d2);
      if (mode === "completion-during-discovery") {
        // D1 уже принят сервером, но его поздний ACK приходит во время чтения D2.
        await flushOutbox(
          box,
          "user",
          async () => ({ status: 200 }),
          (outcome) => {
            for (const listener of listeners) listener(outcome);
          },
        );
        release([]);
      }
      await vi.waitFor(() => expect(client.enqueue).toHaveBeenCalledTimes(2));
      for (const listener of listeners)
        listener({ status: "accepted", item: item1 });
      await Promise.resolve();
      expect(d2.accepted).not.toHaveBeenCalled();
      expect(d2.rejected).not.toHaveBeenCalled();
      const item2 = (await box.list("user")).find(
        (item) => item.id === next.client_event_id,
      )!;
      expect(item2.event).toEqual(next);
      for (const listener of listeners)
        listener({ status: "accepted", item: item2 });
      await vi.waitFor(() => expect(d2.accepted).toHaveBeenCalledOnce());
      expect(d1.accepted).toHaveBeenCalledOnce();
      expect(
        client.enqueue.mock.calls.map(([, event]) => event.client_event_id),
      ).toEqual([original.client_event_id, next.client_event_id]);
    } finally {
      dispose1();
      dispose2();
      await box.close();
    }
  },
);

it.each([
  { status: "accepted" as const, confirmed: true },
  { status: "rejected" as const, confirmed: false },
  { status: "accepted" as const, confirmed: false },
])(
  "removeItem failure settles and disposes exactly once: $status/$confirmed",
  async ({ status, confirmed }) => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: vi.fn(() => {
        throw new Error("cleanup denied");
      }),
    };
    const listeners = new Set<(outcome: OutboxOutcome) => void>();
    const unsubscribe = vi.fn();
    const items: import("../../shared/ws/outbox").PendingEvent[] = [];
    const client = {
      pending: async () => [...items],
      enqueue: vi.fn(async (cardId: string, event: CardEvent) => {
        items.push({
          id: event.client_event_id,
          cardId,
          event,
          userId: "user",
          queuedAt: 0,
          sequence: 1,
        });
      }),
      subscribeOutcomes: (listener: (outcome: OutboxOutcome) => void) => {
        listeners.add(listener);
        return () => {
          unsubscribe();
          listeners.delete(listener);
        };
      },
    };
    const callbacks = () => ({
      identity: "card/brigade/cleanup",
      storage,
      current: () => true,
      accepted: vi.fn(),
      rejected: vi.fn(),
      confirmed: vi.fn(async () => confirmed),
      cachedConfirmed: () => false,
    });
    const original = news();
    if (original.type !== "brigade_said") throw new Error("fixture");
    const first = callbacks();
    let dispose = deliverServiceNews(client, "card", original, first);
    try {
      await vi.waitFor(() => expect(client.enqueue).toHaveBeenCalledOnce());
      const item = items.shift()!;
      for (const listener of listeners) listener({ status, item });
      const expected =
        status === "accepted" && confirmed ? "accepted" : "rejected";
      const opposite = expected === "accepted" ? "rejected" : "accepted";
      await vi.waitFor(() => expect(first[expected]).toHaveBeenCalledOnce());
      expect(first[opposite]).not.toHaveBeenCalled();
      expect(listeners.size).toBe(0);
      expect(unsubscribe).toHaveBeenCalledOnce();
      dispose();
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect([...values.values()].join()).toContain(original.client_event_id);
      const second = callbacks();
      dispose = deliverServiceNews(
        client,
        "card",
        {
          ...original,
          client_event_id: crypto.randomUUID(),
          payload: { ...original.payload, call_id: "replacement-call" },
        },
        second,
      );
      await vi.waitFor(() => expect(second[expected]).toHaveBeenCalledOnce());
      expect(second[opposite]).not.toHaveBeenCalled();
      expect(client.enqueue).toHaveBeenCalledOnce();
      expect(first[expected]).toHaveBeenCalledOnce();
      expect(listeners.size).toBe(0);
      expect(unsubscribe).toHaveBeenCalledTimes(2);
      dispose();
      expect(unsubscribe).toHaveBeenCalledTimes(2);
    } finally {
      dispose();
    }
  },
);

it.each(["pending", "ack-while-unmounted", "already-accepted"])(
  "semantic operation survives owner/call change: %s",
  async (mode) => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    const items: import("../../shared/ws/outbox").PendingEvent[] = [];
    const listeners = new Set<(outcome: OutboxOutcome) => void>();
    let told = false;
    const client = {
      pending: vi.fn(async () => [...items]),
      enqueue: vi.fn(async (cardId: string, event: CardEvent) => {
        items.push({
          id: event.client_event_id,
          cardId,
          event,
          userId: "user",
          queuedAt: 0,
          sequence: 1,
        });
      }),
      subscribeOutcomes: (listener: (outcome: OutboxOutcome) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const callbacks = () => ({
      identity: "card/brigade/delivery",
      storage,
      current: () => true,
      accepted: vi.fn(),
      rejected: vi.fn(),
      confirmed: async () => told,
    });
    const original = news();
    if (original.type !== "brigade_said") throw new Error("fixture");
    let dispose = deliverServiceNews(client, "card", original, callbacks());
    await vi.waitFor(() => expect(client.enqueue).toHaveBeenCalledOnce());
    if (mode === "already-accepted") {
      told = true;
      for (const listener of listeners)
        listener({ status: "accepted", item: items[0] });
      await vi.waitFor(() => expect(values.size).toBe(0));
    }
    dispose();
    if (mode !== "pending") {
      told = true;
      items.splice(0);
    }
    const next = {
      ...original,
      client_event_id: crypto.randomUUID(),
      payload: { ...original.payload, call_id: "new-call" },
    };
    const second = callbacks();
    dispose = deliverServiceNews(client, "card", next, second);
    try {
      await vi.waitFor(() =>
        expect(client.pending.mock.calls.length).toBeGreaterThan(1),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(client.enqueue).toHaveBeenCalledOnce();
      if (mode === "pending") {
        told = true;
        for (const listener of listeners)
          listener({ status: "accepted", item: items[0] });
      }
      await vi.waitFor(() => expect(second.accepted).toHaveBeenCalledOnce());
      expect(values.size).toBe(0);
      // Другая просьба не подавляется подтверждением предыдущей.
      told = false;
      const fresh = {
        ...second,
        identity: "card/brigade/new-delivery",
        accepted: vi.fn(),
      };
      dispose = deliverServiceNews(client, "card", next, fresh);
      await vi.waitFor(() => expect(client.enqueue).toHaveBeenCalledTimes(2));
    } finally {
      dispose();
    }
  },
);
