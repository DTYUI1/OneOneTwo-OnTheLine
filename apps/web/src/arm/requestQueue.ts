/** Фоновые запросы не должны занимать все соединения открытого экрана. */
export function createRequestQueue(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function queued<T>(
    request: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    await new Promise<void>((resolve, reject) => {
      const cancel = () => {
        const index = waiting.indexOf(start);
        if (index >= 0) waiting.splice(index, 1);
        reject(signal.reason);
      };
      const start = () => {
        signal.removeEventListener("abort", cancel);
        active++;
        resolve();
      };
      if (signal.aborted) reject(signal.reason);
      else if (active < limit) start();
      else {
        waiting.push(start);
        signal.addEventListener("abort", cancel, { once: true });
      }
    });
    try {
      signal.throwIfAborted();
      return await request();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}
