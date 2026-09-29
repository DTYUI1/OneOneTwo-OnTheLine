import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assetFor,
  createVoices,
  phraseDurationMs,
  PHRASE_TEXT,
  phraseText,
} from "./voices";

/**
 * Тесты идут в node без DOM, поэтому Audio подменяется. Проверяется не браузер,
 * а наша логика: что считается прозвучавшим, что — сбоем, и что остаётся
 * после отмены.
 */
class FakeAudio {
  static last: FakeAudio | null = null;
  static playBehaviour: "ok" | "blocked" | "device" = "ok";

  muted = false;
  preload = "";
  paused = false;
  loads = 0;
  removed: string[] = [];
  private listeners = new Map<string, (() => void)[]>();

  constructor(public src: string) {
    FakeAudio.last = this;
  }

  addEventListener(type: string, handler: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }

  emit(type: string): void {
    for (const handler of this.listeners.get(type) ?? []) handler();
  }

  play(): Promise<void> {
    if (FakeAudio.playBehaviour === "blocked")
      return Promise.reject(
        new DOMException("autoplay", "NotAllowedError") as unknown as Error,
      );
    if (FakeAudio.playBehaviour === "device")
      return Promise.reject(new Error("device"));
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }

  removeAttribute(name: string): void {
    this.removed.push(name);
  }

  load(): void {
    this.loads += 1;
  }
}

function withAudio() {
  FakeAudio.last = null;
  FakeAudio.playBehaviour = "ok";
  (globalThis as { Audio?: unknown }).Audio = FakeAudio;
}

afterEach(() => {
  delete (globalThis as { Audio?: unknown }).Audio;
  vi.useRealTimers();
});

describe("assetFor", () => {
  it("находит файл профиля", () => {
    const asset = assetFor("voice-1", "listen");
    expect(asset?.url).toBeTruthy();
    expect(asset?.durationMs).toBeGreaterThan(0);
  });

  it("у всех четырёх профилей есть обе фразы", () => {
    for (const profile of ["voice-1", "voice-2", "voice-3", "voice-4"])
      for (const phrase of ["listen", "accepted"] as const)
        expect(
          assetFor(profile, phrase),
          `${profile}/${phrase}`,
        ).not.toBeNull();
  });

  it("без профиля и у чужого профиля файла нет", () => {
    expect(assetFor(null, "listen")).toBeNull();
    expect(assetFor("voice-99", "listen")).toBeNull();
  });
});

describe("phraseDurationMs", () => {
  it("длинную фразу читают дольше короткой", () => {
    expect(phraseDurationMs("accepted")).toBeGreaterThan(
      phraseDurationMs("listen"),
    );
  });

  it("тексты фраз — обязательные по Q14", () => {
    expect(PHRASE_TEXT.listen).toBe("Слушаю вас");
    expect(PHRASE_TEXT.accepted).toBe("Я вас понял, информация принята");
  });

  it("реплика в роде голоса: женский — «поняла», мужской — «понял»", () => {
    expect(phraseText("accepted", "voice-2")).toBe(
      "Я вас поняла, информация принята",
    );
    expect(phraseText("accepted", "voice-1")).toBe(
      "Я вас понял, информация принята",
    );
    expect(phraseText("accepted", null)).toBe(
      "Я вас понял, информация принята",
    );
  });
});

describe("createVoices", () => {
  it("реплика считается прозвучавшей только после конца файла", async () => {
    withAudio();
    const voices = createVoices();
    const playing = voices.play("listen", "voice-1");
    await Promise.resolve();
    FakeAudio.last?.emit("playing");
    FakeAudio.last?.emit("ended");
    const result = await playing;
    expect(result.outcome).toBe("played");
    expect(result.note).toBeNull();
    expect(result.startedInMs).not.toBeNull();
  });

  it("запрет автовоспроизведения — сбой с подсказкой, а не успех", async () => {
    withAudio();
    FakeAudio.playBehaviour = "blocked";
    const result = await createVoices().play("listen", "voice-1");
    expect(result.outcome).toBe("failed");
    expect(result.note).toContain("Браузер не дал");
  });

  it("отказ устройства — тоже сбой", async () => {
    withAudio();
    FakeAudio.playBehaviour = "device";
    const result = await createVoices().play("listen", "voice-1");
    expect(result.outcome).toBe("failed");
    expect(result.note).toBeTruthy();
  });

  it("ошибка элемента не выдаётся за разговор", async () => {
    withAudio();
    const voices = createVoices();
    const playing = voices.play("listen", "voice-1");
    await Promise.resolve();
    FakeAudio.last?.emit("error");
    expect((await playing).outcome).toBe("failed");
  });

  it("нет файла для голоса — сбой, а не молчаливый успех", async () => {
    vi.useFakeTimers();
    withAudio();
    const playing = createVoices().play("listen", "voice-99");
    await vi.advanceTimersByTimeAsync(phraseDurationMs("listen") + 10);
    const result = await playing;
    expect(result.outcome).toBe("failed");
    expect(result.note).toContain("нет файла");
    // Таймер не выдаётся за речь: времени начала звука нет.
    expect(result.startedInMs).toBeNull();
  });

  it("без Audio в окружении реплика не притворяется прозвучавшей", async () => {
    vi.useFakeTimers();
    const playing = createVoices().play("listen", "voice-1");
    await vi.advanceTimersByTimeAsync(phraseDurationMs("listen") + 10);
    expect((await playing).outcome).toBe("failed");
  });

  it("новая реплика останавливает предыдущую — двух сразу не бывает", async () => {
    withAudio();
    const voices = createVoices();
    void voices.play("listen", "voice-1");
    await Promise.resolve();
    const first = FakeAudio.last;
    void voices.play("accepted", "voice-2");
    await Promise.resolve();
    expect(first?.paused).toBe(true);
    expect(first?.removed).toContain("src");
    expect(FakeAudio.last).not.toBe(first);
  });

  it("отмена снимает источник — элемент не держит файл", async () => {
    withAudio();
    const voices = createVoices();
    void voices.play("listen", "voice-1");
    await Promise.resolve();
    const element = FakeAudio.last;
    voices.cancel();
    expect(element?.paused).toBe(true);
    expect(element?.loads).toBe(1);
  });

  it("отключение звука доступно и доходит до элемента", async () => {
    withAudio();
    const voices = createVoices();
    voices.setMuted(true);
    expect(voices.muted).toBe(true);
    void voices.play("listen", "voice-1");
    await Promise.resolve();
    expect(FakeAudio.last?.muted).toBe(true);
  });
});
