import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import type { CardEvent } from "../../shared/api";
import {
  Outbox,
  flushOutbox,
  type OutboxOutcome,
  type PendingEvent,
} from "../../shared/ws/outbox";
import { confirmDial } from "./dialConfirmation";
import { initialModel, reduce } from "./machine";

const dial = (
  callId = crypto.randomUUID(),
): Extract<CardEvent, { type: "call_dial_target" }> => ({
  client_event_id: crypto.randomUUID(),
  client_ts: new Date().toISOString(),
  type: "call_dial_target",
  payload: {
    call_id: callId,
    call_target_id: crypto.randomUUID(),
    brigade_id: crypto.randomUUID(),
  },
});
const item = (event: CardEvent, cardId = "card"): PendingEvent => ({
  id: event.client_event_id,
  userId: "user",
  cardId,
  event,
  queuedAt: 1,
  sequence: 1,
});
function channel(event: CardEvent) {
  const listeners = new Set<(outcome: OutboxOutcome) => void>();
  let pending = [item(event)];
  const client = {
    enqueue: vi.fn(async () => {}),
    pending: vi.fn(async () => pending),
    subscribeOutcomes: (listener: (outcome: OutboxOutcome) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    client,
    listeners,
    setPending: (next: PendingEvent[]) => {
      pending = next;
    },
    emit: (outcome: OutboxOutcome) => {
      for (const listener of listeners) listener(outcome);
    },
  };
}
const callbacks = () => ({
  isCurrent: () => true,
  accepted: vi.fn(),
  rejected: vi.fn(),
});

describe("outgoing dial confirmation (local outcomes, not WS events)", () => {
  it.each(["offline", "network", "preceding blocker"])(
    "%s: a queued dial without failure never starts the simulated answer",
    async () => {
      const event = dial();
      const { client, listeners } = channel(event);
      const confirmation = callbacks();
      const attempt = confirmDial(client, "card", event, confirmation);
      await attempt.queued;
      expect(confirmation.accepted).not.toHaveBeenCalled();
      expect(confirmation.rejected).not.toHaveBeenCalled();
      expect(listeners.size).toBe(1);
      attempt.dispose();
    },
  );

  it("late successful replay starts effects only once after a queued dial", async () => {
    const event = dial();
    const { client, emit } = channel(event);
    const confirmation = callbacks();
    await confirmDial(client, "card", event, confirmation).queued;
    expect(confirmation.accepted).not.toHaveBeenCalled();
    emit({ item: item(event), status: "accepted" });
    emit({ item: item(event), status: "accepted" });
    expect(confirmation.accepted).toHaveBeenCalledTimes(1);
    expect(confirmation.rejected).not.toHaveBeenCalled();
  });

  it("pending absence is not an ACK when an outcome channel exists", async () => {
    const event = dial();
    const { client, setPending, emit } = channel(event);
    setPending([]);
    const confirmation = callbacks();
    const attempt = confirmDial(client, "card", event, confirmation);
    await attempt.queued;
    expect(confirmation.accepted).not.toHaveBeenCalled();
    emit({ item: item(event), status: "accepted" });
    emit({ item: item(event), status: "accepted" });
    expect(confirmation.accepted).toHaveBeenCalledTimes(1);
  });

  it("subscribes before enqueue so an immediate rejection is not lost", async () => {
    const event = dial();
    const { client, emit, listeners } = channel(event);
    client.enqueue.mockImplementation(async () => {
      emit({
        item: item(event),
        status: "rejected",
        code: "line_busy",
        message: "Линия занята.",
      });
    });
    const confirmation = callbacks();
    await confirmDial(client, "card", event, confirmation).queued;
    expect(confirmation.rejected).toHaveBeenCalledWith("Линия занята.");
    expect(confirmation.accepted).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });

  it("late replay busy ends the matching local call and permits a fresh retry", async () => {
    const outbox = new Outbox(crypto.randomUUID());
    const event = dial();
    const { client, emit } = channel(event);
    client.enqueue.mockImplementation(async () => {
      await outbox.add("user", "card", event);
    });
    client.pending.mockImplementation(() => outbox.list("user"));
    let model = reduce(
      { ...initialModel, dialed: "201" },
      {
        type: "dial",
        callId: event.payload.call_id as string,
        at: 1,
      },
    ).model;
    const accepted = vi.fn(() => {
      model = reduce(model, { type: "ring" }).model;
      model = reduce(model, { type: "answer", at: 3 }).model;
    });
    const rejected = vi.fn<(message: string) => void>(() => {
      model = reduce(model, { type: "suspend", at: 2 }).model;
    });
    try {
      await confirmDial(client, "card", event, {
        isCurrent: () => model.callId === event.payload.call_id,
        accepted,
        rejected,
      }).queued;
      expect(model.state).toBe("dialing");
      expect(accepted).not.toHaveBeenCalled();
      await flushOutbox(
        outbox,
        "user",
        async () => ({
          status: 409,
          code: "line_busy",
          message: "Линия занята.",
        }),
        emit,
      );
      expect(rejected).toHaveBeenCalledWith("Линия занята.");
      expect(model.state).toBe("ended");
      expect(model.aborted).toBe(true);
      expect(await outbox.list("user")).toEqual([]);
      const retry = dial();
      model = reduce(model, { type: "clear" }).model;
      for (const digit of "201")
        model = reduce(model, { type: "digit", digit }).model;
      model = reduce(model, {
        type: "dial",
        callId: retry.payload.call_id as string,
        at: 4,
      }).model;
      client.enqueue.mockImplementation(async () => {
        await outbox.add("user", "card", retry);
      });
      await confirmDial(client, "card", retry, {
        isCurrent: () => model.callId === retry.payload.call_id,
        accepted,
        rejected,
      }).queued;
      await flushOutbox(outbox, "user", async () => ({ status: 200 }), emit);
      expect(accepted).toHaveBeenCalledTimes(1);
      expect(model.state).toBe("talking");
    } finally {
      await outbox.close();
    }
  });

  it("ignores other cards, other event IDs and mismatched call IDs", async () => {
    const event = dial();
    const { client, emit } = channel(event);
    const confirmation = callbacks();
    const attempt = confirmDial(client, "card", event, confirmation);
    await attempt.queued;
    const rejected = (pending: PendingEvent) =>
      emit({ item: pending, status: "rejected", message: "Линия занята." });
    rejected(item(event, "other-card"));
    rejected(item({ ...event, client_event_id: crypto.randomUUID() }));
    rejected(item({ ...dial(), client_event_id: event.client_event_id }));
    expect(confirmation.rejected).not.toHaveBeenCalled();
    expect(confirmation.accepted).not.toHaveBeenCalled();
    rejected(item(event));
    expect(confirmation.rejected).toHaveBeenCalledTimes(1);
  });

  it.each(["navigation", "unmount", "disabled", "replacement call"])(
    "fences a late replay after %s",
    async (reason) => {
      const event = dial();
      const { client, emit } = channel(event);
      const scope = {};
      const live = {
        scope,
        mounted: true,
        disabled: false,
        callId: event.payload.call_id,
      };
      const confirmation = {
        ...callbacks(),
        isCurrent: () =>
          live.mounted &&
          !live.disabled &&
          live.scope === scope &&
          live.callId === event.payload.call_id,
      };
      await confirmDial(client, "card", event, confirmation).queued;
      // Mirror the hook's actual lifetime/identity fence at each invalidation.
      if (reason === "navigation") live.scope = {};
      if (reason === "unmount") live.mounted = false;
      if (reason === "disabled") live.disabled = true;
      if (reason === "replacement call") live.callId = crypto.randomUUID();
      emit({ item: item(event), status: "rejected", message: "Линия занята." });
      expect(confirmation.accepted).not.toHaveBeenCalled();
      expect(confirmation.rejected).not.toHaveBeenCalled();
    },
  );

  it("fences pending lookup already in flight and unsubscribes on disposal", async () => {
    const event = dial();
    const { client, emit, listeners } = channel(event);
    let release!: (pending: PendingEvent[]) => void;
    client.pending.mockImplementation(
      () =>
        new Promise<PendingEvent[]>((resolve) => {
          release = resolve;
        }),
    );
    const confirmation = callbacks();
    const attempt = confirmDial(client, "card", event, confirmation);
    await Promise.resolve();
    attempt.dispose();
    release([{ ...item(event), failure: "Линия занята." }]);
    await attempt.queued;
    emit({ item: item(event), status: "accepted" });
    expect(listeners.size).toBe(0);
    expect(confirmation.accepted).not.toHaveBeenCalled();
    expect(confirmation.rejected).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "legacy mock fallback checks the actual dial (pending=%s)",
    async (queued) => {
      const event = dial();
      const confirmation = callbacks();
      await confirmDial(
        {
          enqueue: async () => {},
          pending: async () => (queued ? [item(event)] : []),
        },
        "card",
        event,
        confirmation,
      ).queued;
      expect(confirmation.accepted).toHaveBeenCalledTimes(queued ? 0 : 1);
      expect(confirmation.rejected).not.toHaveBeenCalled();
    },
  );
});
