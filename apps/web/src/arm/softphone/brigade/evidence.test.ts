import { describe, expect, it } from "vitest";
import {
  type Attempt,
  availability,
  brigadesChanged,
  EMPTY_LEDGER,
  type Ledger,
  normalizeBrigades,
  settle,
  waitLeftS,
} from "./evidence";

const NOW = Date.parse("2026-09-24T10:00:30.000Z");

const input = (over: Partial<Parameters<typeof availability>[0]> = {}) => ({
  callState: "talking",
  answeredAtMs: NOW - 20_000,
  availableAfterS: 15,
  nowMs: NOW,
  sessionFinished: false,
  ...over,
});

const attempt = (over: Partial<Attempt> = {}): Attempt => ({
  playbackId: "p-1",
  deliveryId: "d-1",
  messageVersion: 2,
  audioVersion: 3,
  channel: "audio",
  ...over,
});

describe("availability", () => {
  it("в разговоре после срока — можно", () => {
    expect(availability(input())).toBeNull();
  });

  it("до ответа собеседника сведений неоткуда взять", () => {
    expect(
      availability(input({ callState: "ringing", answeredAtMs: null })),
    ).toBe("not-talking");
  });

  it("срок идёт от ответа, а не от набора", () => {
    expect(availability(input({ answeredAtMs: NOW - 5_000 }))).toBe(
      "too-early",
    );
  });

  it("завершённое занятие перекрывает всё остальное", () => {
    expect(availability(input({ sessionFinished: true }))).toBe(
      "session-finished",
    );
  });

  it("показывает, сколько ещё ждать", () => {
    expect(waitLeftS(input({ answeredAtMs: NOW - 5_000 }))).toBe(10);
    expect(waitLeftS(input())).toBe(0);
    expect(waitLeftS(input({ answeredAtMs: null }))).toBe(15);
  });
});

describe("settle", () => {
  it("реально прозвучавшее аудио — предъявление", () => {
    const result = settle(EMPTY_LEDGER, attempt(), "presented");
    expect(result.state).toBe("presented");
    expect(result.emit?.type).toBe("message_presented");
    expect(result.conflict).toBe(false);
  });

  it("для аудио версия обязательна, для текста — null", () => {
    const audio = settle(EMPTY_LEDGER, attempt(), "presented");
    expect(audio.emit?.payload.audio_version).toBe(3);
    const text = settle(
      EMPTY_LEDGER,
      attempt({ channel: "text", audioVersion: 7 }),
      "presented",
    );
    expect(text.emit?.payload.audio_version).toBeNull();
  });

  it("сбой проигрывания не маскируется под успех", () => {
    const result = settle(EMPTY_LEDGER, attempt(), "playback_error");
    expect(result.state).toBe("failed");
    expect(result.emit?.type).toBe("message_failed");
  });

  it("один playback не бывает успешным и неуспешным сразу", () => {
    const first = settle(EMPTY_LEDGER, attempt(), "presented");
    const ledger: Ledger = { state: first.state, settled: first.settled };
    const second = settle(ledger, attempt(), "playback_error");
    expect(second.conflict).toBe(true);
    expect(second.emit).toBeNull();
    expect(second.state).toBe("presented");
  });

  it("повтор не рождает второго сообщения", () => {
    const first = settle(EMPTY_LEDGER, attempt(), "presented");
    const again = settle(
      { state: first.state, settled: first.settled },
      attempt(),
      "presented",
    );
    expect(again.emit).toBeNull();
    expect(again.settled).toHaveLength(1);
  });

  it("поздний сбой другой попытки не отменяет предъявления", () => {
    const ok = settle(
      EMPTY_LEDGER,
      attempt({ playbackId: "p-1" }),
      "presented",
    );
    const late = settle(
      { state: ok.state, settled: ok.settled },
      attempt({ playbackId: "p-2" }),
      "interrupted",
    );
    // Сам сбой в журнал уходит, но состояние остаётся предъявленным.
    expect(late.emit?.type).toBe("message_failed");
    expect(late.state).toBe("presented");
  });

  it("после сбоя повторная попытка всё ещё может предъявить", () => {
    const bad = settle(
      EMPTY_LEDGER,
      attempt({ playbackId: "p-1" }),
      "interrupted",
    );
    const good = settle(
      { state: bad.state, settled: bad.settled },
      attempt({ playbackId: "p-2" }),
      "presented",
    );
    expect(good.state).toBe("presented");
    expect(good.emit?.type).toBe("message_presented");
  });

  it("завершение занятия — причина сбоя, а не тихое исчезновение", () => {
    const result = settle(EMPTY_LEDGER, attempt(), "session_finished");
    expect(result.emit?.type).toBe("message_failed");
    if (result.emit?.type === "message_failed")
      expect(result.emit.payload.reason).toBe("session_finished");
  });
});

describe("набор бригад", () => {
  it("дубли убираются, порядок не важен", () => {
    expect(normalizeBrigades(["b", "a", "b"])).toEqual(["a", "b"]);
  });

  it("перестановка не считается изменением", () => {
    expect(brigadesChanged(["a", "b"], ["b", "a"])).toBe(false);
  });

  it("другой состав считается изменением", () => {
    expect(brigadesChanged(["a"], ["a", "b"])).toBe(true);
    expect(brigadesChanged(["a", "b"], ["a"])).toBe(true);
  });
});
