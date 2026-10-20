import { describe, expect, it } from "vitest";
import {
  createToolsStore,
  parseTools,
  pinnedFirst,
  toolsKey,
} from "./toolsStore";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
const reminder = {
  cardId: "a",
  number: "70001",
  text: "Уточнить прибытие",
  dueAt: 1800000000000,
};

describe("Личные инструменты карточек", () => {
  it("закрытие напоминания сохраняет исходный срок и повтор через 20 секунд", () => {
    const storage = memoryStorage();
    const store = createToolsStore("one", storage);
    store.saveReminder({ ...reminder, hiddenUntil: reminder.dueAt + 20_000 });
    const reopened = createToolsStore("one", storage).getSnapshot()
      .reminders[0];
    expect(reopened.dueAt).toBe(reminder.dueAt);
    expect(reopened.hiddenUntil).toBe(reminder.dueAt + 20_000);
    store.saveReminder({
      ...reopened,
      hiddenUntil: undefined,
      dueAt: reminder.dueAt + 120_000,
    });
    expect(store.getSnapshot().reminders[0].hiddenUntil).toBeUndefined();
    expect(
      parseTools(
        JSON.stringify({ reminders: [{ ...reminder, hiddenUntil: "broken" }] }),
      ).reminders,
    ).toEqual([]);
  });
  it("закреплённая карточка остаётся первой при новых поступлениях; открепление возвращает порядок", () => {
    const storage = memoryStorage();
    const store = createToolsStore("one", storage);
    store.togglePin("older");
    const cards = [{ id: "new" }, { id: "older" }, { id: "oldest" }];
    expect(
      pinnedFirst(cards, store.getSnapshot().pinned).map((c) => c.id),
    ).toEqual(["older", "new", "oldest"]);
    store.togglePin("older");
    expect(pinnedFirst(cards, store.getSnapshot().pinned)).toEqual(cards);
  });
  it("переживает перезапуск, сохраняет исходный срок и не смешивает пользователей", () => {
    const storage = memoryStorage();
    const store = createToolsStore("one", storage);
    store.togglePin("a");
    store.saveReminder(reminder);
    const reopened = createToolsStore("one", storage);
    expect(reopened.getSnapshot()).toMatchObject({
      pinned: ["a"],
      reminders: [reminder],
    });
    expect(createToolsStore("two", storage).getSnapshot()).toMatchObject({
      pinned: [],
      reminders: [],
    });
  });
  it("изменение и удаление одного напоминания не затрагивает соседнее", () => {
    const store = createToolsStore("one", memoryStorage());
    store.saveReminder(reminder);
    store.saveReminder({ ...reminder, cardId: "b" });
    store.saveReminder({
      ...reminder,
      text: "Перезвонить",
      dueAt: reminder.dueAt + 120000,
    });
    expect(store.getSnapshot().reminders).toHaveLength(2);
    expect(
      store.getSnapshot().reminders.find((r) => r.cardId === "a")?.text,
    ).toBe("Перезвонить");
    store.removeReminder("a");
    expect(store.getSnapshot().reminders.map((r) => r.cardId)).toEqual(["b"]);
  });
  it("не теряет изменения другой вкладки", () => {
    const storage = memoryStorage();
    const first = createToolsStore("one", storage);
    const second = createToolsStore("one", storage);
    first.togglePin("a");
    second.saveReminder(reminder);
    first.reload();
    expect(first.getSnapshot()).toMatchObject({
      pinned: ["a"],
      reminders: [reminder],
    });
  });
  it("повреждённое хранилище не ломает экран; негодные напоминания отбрасываются", () => {
    expect(parseTools("{broken")).toEqual({ pinned: [], reminders: [] });
    expect(
      parseTools(
        JSON.stringify({
          pinned: ["a", null, "a"],
          reminders: [
            null,
            7,
            {},
            { ...reminder, dueAt: "tomorrow" },
            { ...reminder, text: " " },
            reminder,
          ],
        }),
      ),
    ).toEqual({ pinned: ["a"], reminders: [reminder] });
    const storage = memoryStorage();
    storage.setItem(toolsKey("one"), "{}");
    expect(createToolsStore("one", storage).getSnapshot().reminders).toEqual(
      [],
    );
  });
  it("при запрете записи продолжает работать в памяти и сообщает об ограничении", () => {
    const store = createToolsStore("one", {
      getItem: () => null,
      setItem: () => {
        throw new Error("Quota exceeded");
      },
    });
    store.togglePin("a");
    store.saveReminder(reminder);
    expect(store.getSnapshot()).toMatchObject({
      pinned: ["a"],
      reminders: [reminder],
      persistent: false,
    });
  });
});
