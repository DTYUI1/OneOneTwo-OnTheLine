import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SOUND,
  getSound,
  parseSound,
  resetSound,
  setSound,
  soundGain,
  SOUND_KEY,
  subscribeSound,
} from "./urgencySound";

// TC-06: громкость и «без звука» сигналов срочности помнятся.

function stubStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  });
  return data;
}

afterEach(() => {
  resetSound();
  vi.unstubAllGlobals();
});

describe("настройка звука срочности", () => {
  it("чужое и битое — настройка по умолчанию, громкость зажата в 0…1", () => {
    expect(parseSound(null)).toEqual(DEFAULT_SOUND);
    expect(parseSound("не json")).toEqual(DEFAULT_SOUND);
    expect(parseSound("5")).toEqual(DEFAULT_SOUND);
    expect(parseSound('{"muted":true,"volume":3}')).toEqual({
      muted: true,
      volume: 1,
    });
    expect(parseSound('{"muted":"да","volume":-1}')).toEqual({
      muted: false,
      volume: 0,
    });
  });

  it("множитель: 0,5 — уровень остальных сигналов, «без звука» — ноль", () => {
    expect(soundGain({ muted: false, volume: 0.5 })).toBe(1);
    expect(soundGain({ muted: false, volume: 1 })).toBe(2);
    expect(soundGain({ muted: false, volume: 0 })).toBe(0);
    expect(soundGain({ muted: true, volume: 1 })).toBe(0);
  });

  it("выбор запоминается и читается после перезагрузки страницы", () => {
    const data = stubStorage();
    const seen = vi.fn();
    const stop = subscribeSound(seen);
    setSound({ muted: true, volume: 0.3 });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(JSON.parse(data.get(SOUND_KEY) ?? "")).toEqual({
      muted: true,
      volume: 0.3,
    });
    stop();

    resetSound(); // «перезагрузка»: память страницы пуста, остался localStorage
    expect(getSound()).toEqual({ muted: true, volume: 0.3 });
  });

  it("хранилище не открылось — настройка живёт до перезагрузки, ошибок нет", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("закрыто");
      },
      setItem: () => {
        throw new Error("закрыто");
      },
    });
    expect(getSound()).toEqual(DEFAULT_SOUND);
    setSound({ muted: true, volume: 0.5 });
    expect(getSound().muted).toBe(true);
  });
});
