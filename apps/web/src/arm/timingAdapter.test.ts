import { describe, expect, it } from "vitest";
import {
  cardLiveTiming,
  liveTiming,
  timingEvents,
  timingInput,
  type TimingContext,
} from "./timingAdapter";

const T0 = Date.parse("2026-09-25T10:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
// Показана на АРМ сразу после выдачи: направление совпадает с появлением.
const card = {
  id: "00000000-0000-4000-8000-0000000000c1",
  appeared_at: at(0),
  delivered_at: at(0),
  interrupted_at: null,
};
const ev = (
  id: string,
  type: string,
  s: number,
  payload: Record<string, unknown> = {},
) => ({
  id: `00000000-0000-4000-8000-0000000000${id}`,
  type,
  payload,
  client_ts: at(s),
  server_ts: at(s),
});

// TimingPolicy.examples[1] из contracts/openapi.json — v3 по умолчанию для новых занятий.
const v3: TimingContext = {
  sessionId: "00000000-0000-4000-8000-000000000400",
  policy: {
    timing_version: 3,
    reaction_normative_s: 30,
    handling_normative_s: 180,
    waiting_policy: "exclude_confirmed",
    max_rtt_ms: 2000,
    max_sample_age_ms: 60000,
    max_buffer_delay_ms: 30000,
    future_tolerance_ms: 250,
  },
  legacyReactionS: 30,
  legacyHandlingS: 180,
};

describe("таймеры АРМ через общий расчёт C-02", () => {
  it("строит вход по I-TIME: direct из delivered_at, status_change → status", () => {
    const events = timingEvents(card, [
      ev("01", "deliver", 1),
      ev("02", "open", 20),
      ev("03", "field_change", 25, { field: "comment", value: "x" }),
      ev("04", "status_change", 40, { state: "accepted", comment: "ок" }),
    ]);
    expect(events.map((e) => [e.kind, e.state])).toEqual([
      ["direct", null],
      ["deliver", null],
      ["open", null],
      ["status", "accepted"],
    ]);
    expect(events[0]).toMatchObject({ event_id: card.id, clock: null });
  });

  it("пример контракта 0/20/40/190 → реакция 40, обработка 170", () => {
    const events = [
      ev("02", "open", 20),
      ev("04", "status_change", 40, { state: "accepted", comment: "ок" }),
      ev("05", "status_change", 190, { state: "completed", comment: "ок" }),
    ];
    const live = liveTiming(timingInput(card, events, v3, T0 + 200_000));
    expect(live.version).toBe(3);
    expect(live.reaction).toMatchObject({
      seconds: 40,
      running: false,
      over: true,
    });
    expect(live.handling).toMatchObject({ seconds: 170, running: false });
  });

  it("идущая реакция v3 не закрывается открытием — считается до «сейчас»", () => {
    const events = [ev("02", "open", 20)];
    const live = liveTiming(timingInput(card, events, v3, T0 + 25_000));
    expect(live.reaction).toMatchObject({
      seconds: 25,
      running: true,
      over: false,
    });
    expect(live.handling).toMatchObject({ seconds: 5, running: true });
  });

  it("обработка не идёт, пока карточку не открыли", () => {
    const live = liveTiming(timingInput(card, [], v3, T0 + 10_000));
    expect(live.handling).toMatchObject({ seconds: null, running: false });
    expect(live.reaction.running).toBe(true);
  });

  it("legacy v1 (policy=null): реакция — deliver → open", () => {
    const events = [ev("01", "deliver", 2), ev("02", "open", 12)];
    const live = liveTiming(
      timingInput(card, events, { ...v3, policy: null }, T0 + 60_000),
    );
    expect(live.version).toBe(1);
    expect(live.reaction).toMatchObject({ seconds: 10, running: false });
  });

  it("реакция идёт с показа на АРМ, а не с выдачи: вход с опозданием не штрафуется", () => {
    // Выдана в 0, обучаемый вошёл и увидел строку на 600-й секунде.
    const late = { ...card, delivered_at: at(600) };
    const events = [ev("01", "deliver", 600)];
    const live = liveTiming(timingInput(late, events, v3, T0 + 610_000));
    expect(live.reaction).toMatchObject({ seconds: 10, running: true });
  });

  it("не показанная карточка отсчёта не имеет", () => {
    const hidden = { ...card, delivered_at: null };
    expect(timingEvents(hidden, []).map((e) => e.kind)).toEqual([]);
    const live = liveTiming(timingInput(hidden, [], v3, T0 + 3_600_000));
    expect(live.reaction).toMatchObject({ seconds: null, running: false });
  });

  it("прерванная попытка замирает на моменте прерывания", () => {
    // Занятие завершили на 50-й секунде, а смотрим через час.
    const stopped = { ...card, interrupted_at: at(50) };
    const events = [ev("02", "open", 20)];
    const live = cardLiveTiming(stopped, events, v3, T0 + 3_600_000);
    expect(live.reaction).toMatchObject({ seconds: 50, running: false });
    expect(live.handling).toMatchObject({ seconds: 30, running: false });
  });
});
