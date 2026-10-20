import { useEffect, useMemo, useSyncExternalStore } from "react";

export type Reminder = {
  cardId: string;
  number: string;
  text: string;
  dueAt: number;
  hiddenUntil?: number;
};
export type ToolsData = { pinned: string[]; reminders: Reminder[] };
type StorageLike = Pick<Storage, "getItem" | "setItem">;
const empty = (): ToolsData => ({ pinned: [], reminders: [] });
export const toolsKey = (userId: string) => `arm:card-tools:v1:${userId}`;

/** Browser data is untrusted: an old or damaged record must not break the ARM. */
export function parseTools(raw: string | null): ToolsData {
  try {
    const data: unknown = JSON.parse(raw ?? "null");
    if (!data || typeof data !== "object") return empty();
    const { pinned, reminders } = data as Partial<ToolsData>;
    return {
      pinned: Array.isArray(pinned)
        ? [...new Set(pinned.filter((id) => typeof id === "string"))]
        : [],
      reminders: Array.isArray(reminders)
        ? reminders.filter(
            (r): r is Reminder =>
              Boolean(r) &&
              typeof r.cardId === "string" &&
              typeof r.number === "string" &&
              typeof r.text === "string" &&
              r.text.trim().length > 0 &&
              r.text.length <= 300 &&
              Number.isFinite(r.dueAt) &&
              r.dueAt > 0 &&
              (r.hiddenUntil === undefined ||
                (Number.isFinite(r.hiddenUntil) && r.hiddenUntil >= 0)),
          )
        : [],
    };
  } catch {
    return empty();
  }
}

export function pinnedFirst<T extends { id: string }>(
  items: readonly T[],
  pinned: readonly string[],
): T[] {
  const ids = new Set(pinned);
  return [...items].sort(
    (a, b) => Number(ids.has(b.id)) - Number(ids.has(a.id)),
  );
}

export function createToolsStore(userId: string, storage: StorageLike | null) {
  const key = toolsKey(userId);
  const listeners = new Set<() => void>();
  let persistent = Boolean(storage);
  const read = () => {
    try {
      return parseTools(storage?.getItem(key) ?? null);
    } catch {
      persistent = false;
      return empty();
    }
  };
  let data = read();
  let snapshot = { ...data, persistent };
  const notify = () => {
    snapshot = { ...data, persistent };
    listeners.forEach((listener) => listener());
  };
  const update = (change: (value: ToolsData) => ToolsData) => {
    // Merge against the latest stored data if another tab changed a different card.
    if (persistent) data = read();
    data = change(data);
    try {
      if (!storage) throw new Error("Storage unavailable");
      storage.setItem(key, JSON.stringify(data));
      persistent = true;
    } catch {
      persistent = false;
    }
    notify();
  };
  return {
    key,
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reload: () => {
      data = read();
      notify();
    },
    togglePin: (cardId: string) =>
      update((value) => ({
        ...value,
        pinned: value.pinned.includes(cardId)
          ? value.pinned.filter((id) => id !== cardId)
          : [...value.pinned, cardId],
      })),
    saveReminder: (reminder: Reminder) => {
      if (
        parseTools(JSON.stringify({ reminders: [reminder] })).reminders
          .length !== 1
      )
        throw new Error("Укажите текст и время напоминания.");
      update((value) => ({
        ...value,
        reminders: [
          ...value.reminders.filter((r) => r.cardId !== reminder.cardId),
          reminder,
        ],
      }));
    },
    removeReminder: (cardId: string) =>
      update((value) => ({
        ...value,
        reminders: value.reminders.filter((r) => r.cardId !== cardId),
      })),
  };
}

export function useToolsStore(userId: string) {
  const store = useMemo(() => {
    let storage: StorageLike | null = null;
    try {
      storage = window.localStorage;
    } catch {
      /* Memory-only mode. */
    }
    return createToolsStore(userId, storage);
  }, [userId]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => {
    const refresh = (event: StorageEvent) => {
      if (event.key === store.key || event.key === null) store.reload();
    };
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, [store]);
  return { ...store, ...state };
}
export type ToolsStore = ReturnType<typeof useToolsStore>;
