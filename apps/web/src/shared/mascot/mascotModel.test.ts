import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MASCOT_KEY,
  mascotKey,
  mascotShown,
  mascotVoice,
  resetMascot,
  setMascotShown,
  setMascotUser,
  setMascotVoice,
  subscribeMascot,
  VOICE_KEY,
} from "./mascotModel";

// Обучаемый убирает наставника для себя (библия маскота, раздел 8) — выбор помнится.

function stubStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  });
  return data;
}

beforeEach(() => setMascotUser("u1"));
afterEach(() => {
  setMascotUser(null);
  resetMascot();
  vi.unstubAllGlobals();
});

describe("наставник в подсказках", () => {
  it("по умолчанию показан", () => {
    stubStorage();
    expect(mascotShown()).toBe(true);
  });

  it("выключен — помнится после перезагрузки, включён — запись убрана", () => {
    const data = stubStorage();
    setMascotShown(false);
    expect(data.get(mascotKey(MASCOT_KEY, "u1"))).toBe("1");
    resetMascot();
    expect(mascotShown()).toBe(false);
    setMascotShown(true);
    expect(data.has(mascotKey(MASCOT_KEY, "u1"))).toBe(false);
  });

  it("хранилище недоступно — настройка живёт до перезагрузки", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("приватное окно");
      },
      setItem: () => {
        throw new Error("приватное окно");
      },
      removeItem: () => {
        throw new Error("приватное окно");
      },
    });
    expect(mascotShown()).toBe(true);
    setMascotShown(false);
    expect(mascotShown()).toBe(false);
  });

  it("сообщает подписчикам о смене", () => {
    stubStorage();
    const listener = vi.fn();
    const stop = subscribeMascot(listener);
    setMascotShown(false);
    stop();
    setMascotShown(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("у каждого пользователя своя настройка: фигура и голос (проверка 20.10)", () => {
    const data = stubStorage();
    setMascotShown(false);
    setMascotVoice(false);
    const listener = vi.fn();
    const stop = subscribeMascot(listener);
    // Смена входа без перезагрузки: подписчики перечитывают настройку другого пользователя.
    setMascotUser("u2");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(mascotShown()).toBe(true);
    expect(mascotVoice()).toBe(true);
    setMascotUser("u1");
    expect(mascotShown()).toBe(false);
    expect(mascotVoice()).toBe(false);
    stop();
    expect([...data.keys()].sort()).toEqual(
      [mascotKey(MASCOT_KEY, "u1"), mascotKey(VOICE_KEY, "u1")].sort(),
    );
  });

  it("прежний общий ключ без пользователя не действует ни на кого", () => {
    stubStorage({ [MASCOT_KEY]: "1" });
    expect(mascotShown()).toBe(true);
    setMascotUser(null);
    expect(mascotShown()).toBe(true);
  });
});
