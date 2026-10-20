import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { RealtimeClient } from "./client";
import { Outbox } from "./outbox";
import type { CardEvent } from "../api";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("../api", () => ({ api: { POST: post }, csrfToken: () => "csrf" }));

// Exercise the real client flush without starting sockets, browser listeners,
// heartbeat or role discovery. Private access is confined to this test seam.
async function clientFixture() {
  const client = new RealtimeClient("user", () => {});
  const queue = client as unknown as { outbox: Outbox; stopped: boolean; flush(): Promise<void> };
  await queue.outbox.close();
  queue.outbox = new Outbox(crypto.randomUUID());
  queue.stopped = false;
  return { client, queue };
}
const dial = (): CardEvent => ({
  client_event_id: crypto.randomUUID(), client_ts: new Date().toISOString(),
  type: "call_dial_target",
  payload: { call_id: crypto.randomUUID(), call_target_id: crypto.randomUUID(), brigade_id: crypto.randomUUID() },
});

describe("RealtimeClient local outcome channel", () => {
  it("publishes a late replay rejection only after deleting the busy dial", async () => {
    const { client, queue } = await clientFixture();
    const event = dial();
    const outcomes = vi.fn();
    const snapshots: Promise<unknown>[] = [];
    const unsubscribe = client.subscribeOutcomes((outcome) => {
      outcomes(outcome);
      snapshots.push(client.pending());
    });
    try {
      post.mockResolvedValueOnce({ response: { status: 503 } });
      await client.enqueue("card", event);
      expect(outcomes).not.toHaveBeenCalled();
      expect(await client.pending()).toHaveLength(1);
      post.mockResolvedValueOnce({ response: { status: 409 }, error: { code: "line_busy", message: "Линия занята." } });
      await queue.flush();
      expect(outcomes).toHaveBeenCalledTimes(1);
      expect(outcomes.mock.calls[0][0]).toMatchObject({
        item: { cardId: "card", id: event.client_event_id, event },
        status: "rejected", code: "line_busy", message: "Линия занята.",
      });
      expect(await Promise.all(snapshots)).toEqual([[]]);
      expect(await client.pending()).toEqual([]);
    } finally { unsubscribe(); queue.stopped = true; await queue.outbox.close(); }
  });

  it("isolates throwing consumers and unsubscribes without extending WS events", async () => {
    const { client, queue } = await clientFixture();
    const broken = client.subscribeOutcomes(() => { throw new Error("consumer"); });
    const outcomes = vi.fn();
    const unsubscribe = client.subscribeOutcomes(outcomes);
    try {
      post.mockResolvedValue({ response: { status: 200 } });
      await client.enqueue("card", dial());
      expect(outcomes).toHaveBeenCalledTimes(1);
      expect(outcomes.mock.calls[0][0].status).toBe("accepted");
      unsubscribe();
      await client.enqueue("card", dial());
      expect(outcomes).toHaveBeenCalledTimes(1);
      expect(await client.pending()).toEqual([]);
    } finally { broken(); unsubscribe(); queue.stopped = true; await queue.outbox.close(); }
  });
});
