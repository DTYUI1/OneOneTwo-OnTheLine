import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { useIncomingSignal, type IncomingSignal } from "./useIncomingSignal";
import { alarmCallSignal, brigadeCallSignal, stopCallSignal } from "../signals";

const refs = vi.hoisted(() => ({ heard: new Set<string>() }));
vi.mock("react", () => ({
  useRef: () => ({ current: refs.heard }),
  useEffect: vi.fn(),
}));
vi.mock("../signals", () => ({
  alarmCallSignal: vi.fn(),
  brigadeCallSignal: vi.fn(),
  stopCallSignal: vi.fn(),
}));

// Выполняем эффекты хука после обновления входящих; ref сохраняется между обновлениями.
function update(incoming: readonly IncomingSignal[]) {
  vi.mocked(useEffect).mockClear();
  useIncomingSignal(incoming);
  vi.mocked(useEffect).mock.calls[0][0]();
}

beforeEach(() => {
  vi.clearAllMocks();
  refs.heard.clear();
});

describe("общий рингтон АРМ", () => {
  const brigade = { callId: "brigade", alarm: false };
  const control = { callId: "control", alarm: false };
  const alarm = { callId: "alarm", alarm: true };

  it("не повторяет звук при открытии окна, смене карточки и перечитывании; новый вызов звучит", () => {
    update([brigade]);
    update([{ ...brigade }]);
    update([]);
    update([brigade]);
    expect(brigadeCallSignal).toHaveBeenCalledTimes(1);
    update([brigade, control]);
    expect(brigadeCallSignal).toHaveBeenCalledTimes(2);
  });

  it("один сигнал на одновременные вызовы; тревога имеет приоритет", () => {
    update([brigade, control, alarm]);
    expect(alarmCallSignal).toHaveBeenCalledOnce();
    expect(brigadeCallSignal).not.toHaveBeenCalled();
    update([alarm]);
    expect(alarmCallSignal).toHaveBeenCalledOnce();
  });

  it("ответ, пропуск последнего вызова и уход из АРМ обрывают оставшуюся трель", () => {
    update([control]);
    update([]);
    expect(stopCallSignal).toHaveBeenCalledOnce();
    const cleanup = vi.mocked(useEffect).mock.calls[1][0]();
    if (typeof cleanup === "function") cleanup();
    expect(stopCallSignal).toHaveBeenCalledTimes(2);
  });

  it("StrictMode: после пробного cleanup активный входящий снова звучит", () => {
    update([control]);
    const cleanup = vi.mocked(useEffect).mock.calls[1][0]();
    if (typeof cleanup === "function") cleanup();
    update([control]);
    expect(brigadeCallSignal).toHaveBeenCalledTimes(2);
    expect(stopCallSignal).toHaveBeenCalledOnce();
  });
});
