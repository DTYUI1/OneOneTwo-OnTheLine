import { describe, expect, it, vi } from "vitest";
import { createRequestQueue } from "./requestQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("Очередь фоновых запросов", () => {
  it("ограничивает параллелизм и освобождает место после ошибки", async () => {
    const queue = createRequestQueue(2);
    const first = deferred<number>();
    const second = deferred<number>();
    const signal = new AbortController().signal;
    const requests = [
      vi.fn(() => first.promise),
      vi.fn(() => second.promise),
      vi.fn(async () => 3),
    ];
    const results = requests.map((request) => queue(request, signal));
    const settled = Promise.allSettled(results);
    await Promise.resolve();
    expect(requests.map((request) => request.mock.calls.length)).toEqual([
      1, 1, 0,
    ]);
    const failure = new Error("Нет связи");
    first.reject(failure);
    await expect(results[0]).rejects.toBe(failure);
    await expect(results[2]).resolves.toBe(3);
    second.resolve(2);
    expect((await settled).map((result) => result.status)).toEqual([
      "rejected",
      "fulfilled",
      "fulfilled",
    ]);
  });

  it("отменённый ожидающий запрос не занимает место и не отправляется", async () => {
    const queue = createRequestQueue(1);
    const first = deferred<number>();
    const active = queue(() => first.promise, new AbortController().signal);
    const controller = new AbortController();
    const request = vi.fn(async () => 2);
    const waiting = queue(request, controller.signal);
    const cancelled = expect(waiting).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await cancelled;
    const next = queue(async () => 3, new AbortController().signal);
    first.resolve(1);
    await expect(active).resolves.toBe(1);
    await expect(next).resolves.toBe(3);
    expect(request).not.toHaveBeenCalled();
  });

  it("отмена до запуска запроса не мешает последующему запросу", async () => {
    const queue = createRequestQueue(1);
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn(async () => 1);
    await expect(queue(request, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(
      queue(async () => 2, new AbortController().signal),
    ).resolves.toBe(2);
    expect(request).not.toHaveBeenCalled();
  });
});
