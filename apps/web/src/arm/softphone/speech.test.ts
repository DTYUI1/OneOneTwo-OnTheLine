import { describe, expect, it } from "vitest";
import {
  HOLD_MS,
  MAX_LISTEN_MS,
  MIN_LISTEN_MS,
  SILENCE_MS,
  reportMayStart,
  rms,
  serviceReplyMayStart,
} from "./speech";

const answered = 10_000;

describe("Бригада слушает диспетчера", () => {
  it("молчит первые 2 с после ответа, даже если доклад готов", () => {
    expect(
      reportMayStart({
        now: answered + MIN_LISTEN_MS - 1,
        talkStartedAt: answered,
        reportSeenAt: answered,
        lastVoiceAt: null,
      }),
    ).toBe(false);
  });

  it("докладывает через 2 с, если диспетчер молчит или микрофона нет", () => {
    expect(
      reportMayStart({
        now: answered + MIN_LISTEN_MS,
        talkStartedAt: answered,
        reportSeenAt: answered + 500,
        lastVoiceAt: null,
      }),
    ).toBe(true);
  });

  it("ждёт паузы, пока диспетчер говорит", () => {
    const now = answered + 3000;
    expect(
      reportMayStart({
        now,
        talkStartedAt: answered,
        reportSeenAt: answered + 2500,
        lastVoiceAt: now - 100,
      }),
    ).toBe(false);
    expect(
      reportMayStart({
        now,
        talkStartedAt: answered,
        reportSeenAt: answered + 2500,
        lastVoiceAt: now - SILENCE_MS,
      }),
    ).toBe(true);
  });

  it("не ждёт дольше 5 с после ответа", () => {
    const now = answered + MAX_LISTEN_MS;
    expect(
      reportMayStart({
        now,
        talkStartedAt: answered,
        reportSeenAt: answered + 3000,
        lastVoiceAt: now,
      }),
    ).toBe(true);
  });

  it("поздний доклад ждёт паузы не дольше 1,5 с", () => {
    const seen = answered + 60_000;
    const talking = (now: number) =>
      reportMayStart({
        now,
        talkStartedAt: answered,
        reportSeenAt: seen,
        lastVoiceAt: now,
      });
    expect(talking(seen + HOLD_MS - 1)).toBe(false);
    expect(talking(seen + HOLD_MS)).toBe(true);
  });
});

describe("Уровень сигнала", () => {
  it("тишина — ноль, полная амплитуда — единица", () => {
    expect(rms(new Float32Array(8))).toBe(0);
    expect(rms(new Float32Array([1, -1, 1, -1]))).toBe(1);
    expect(rms(new Float32Array())).toBe(0);
  });
});

describe("Ответ общего адресата после доклада", () => {
  const greetingEndedAt = 10_000;
  it("не считает собственное приветствие адресата и отсутствие микрофона речью", () => {
    expect(
      serviceReplyMayStart({ now: 20_000, greetingEndedAt, lastVoiceAt: null }),
    ).toBe(false);
    expect(
      serviceReplyMayStart({
        now: 20_000,
        greetingEndedAt,
        lastVoiceAt: 10_100,
      }),
    ).toBe(false);
  });

  it("ждёт паузы после речи диспетчера", () => {
    const input = { greetingEndedAt, lastVoiceAt: 11_000 };
    expect(serviceReplyMayStart({ ...input, now: 12_199 })).toBe(false);
    expect(serviceReplyMayStart({ ...input, now: 12_200 })).toBe(true);
  });
});
