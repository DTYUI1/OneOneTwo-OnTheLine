import { afterEach, expect, it, vi } from "vitest";
import {
  acknowledgeHelpTip,
  acknowledgeWelcome,
  hasSeenHelpTip,
  hasSeenWelcome,
} from "./welcome";

afterEach(() => vi.unstubAllGlobals());

it("первое знакомство сохраняется отдельно для каждого аккаунта", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const user = crypto.randomUUID();
  expect(hasSeenWelcome(user)).toBe(false);
  acknowledgeWelcome(user);
  expect(hasSeenWelcome(user)).toBe(true);
  expect(values.get(`arm112:welcome:v1:${user}`)).toBe("seen");
  expect(hasSeenWelcome(crypto.randomUUID())).toBe(false);
});

it("учитывает сохранённое знакомство после загрузки приложения", () => {
  vi.stubGlobal("localStorage", { getItem: () => "seen" });
  expect(hasSeenWelcome(crypto.randomUUID())).toBe(true);
});

it("не блокирует работу, если браузер запрещает storage", () => {
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("Storage disabled");
    },
    setItem: () => {
      throw new Error("Storage disabled");
    },
  });
  const user = crypto.randomUUID();
  expect(hasSeenWelcome(user)).toBe(false);
  expect(() => acknowledgeWelcome(user)).not.toThrow();
  expect(hasSeenWelcome(user)).toBe(true);
});

it("подсказка к «?» показывается один раз и отдельно от приветствия", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const user = crypto.randomUUID();
  acknowledgeWelcome(user);
  expect(hasSeenHelpTip(user)).toBe(false);
  acknowledgeHelpTip(user);
  expect(hasSeenHelpTip(user)).toBe(true);
  expect(values.get(`arm112:help-tip:v1:${user}`)).toBe("seen");
  expect(hasSeenHelpTip(crypto.randomUUID())).toBe(false);
});
