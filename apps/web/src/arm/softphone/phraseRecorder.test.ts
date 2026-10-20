import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPhraseRecorder } from "./phraseRecorder";

const trackStop = vi.fn();
class TestRecorder {
  static isTypeSupported() {
    return true;
  }
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["учебная запись"]) });
    this.onstop?.();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  trackStop.mockClear();
  vi.stubGlobal("window", { isSecureContext: true });
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: async () => ({ getTracks: () => [{ stop: trackStop }] }),
    },
  });
  vi.stubGlobal("MediaRecorder", TestRecorder);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("лимит записи STT", () => {
  it("заканчивает фразу ровно на 10-й секунде и освобождает микрофон", async () => {
    const recorder = createPhraseRecorder();
    let phrase: Blob | null = null;
    const finish = vi.fn(async () => {
      phrase = await recorder.stop();
    });
    expect(await recorder.start(finish)).toBeNull();
    await vi.advanceTimersByTimeAsync(9999);
    expect(finish).not.toHaveBeenCalled();
    expect(trackStop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(phrase).toBeInstanceOf(Blob);
    expect(trackStop).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it.each(["stop", "cancel"] as const)(
    "%s раньше лимита отменяет автоматическую остановку",
    async (action) => {
      const recorder = createPhraseRecorder();
      const finish = vi.fn();
      await recorder.start(finish);
      await vi.advanceTimersByTimeAsync(4000);
      await recorder[action]();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(finish).not.toHaveBeenCalled();
      expect(trackStop).toHaveBeenCalledTimes(1);
    },
  );
});
