import { describe, expect, it } from "vitest";
import {
  ALARM_TONES,
  BRIGADE_RING_TONES,
  NEW_CARD_TONES,
  RING_ATTACK_S,
  RING_PERIOD_S,
  URGENCY_OVER_TONES,
  URGENCY_WARN_TONES,
  type Tone,
} from "./signals";

// TC-01: трель доклада бригады отличается от сигнала новой карточки на слух — частотой,
// длиной и атакой; звучит один раз (две трели) и гаснет.

const end = (tones: readonly Tone[]) =>
  Math.max(...tones.map((tone) => tone.at + tone.seconds));

describe("расписание тонов сигналов", () => {
  it("трель доклада — 440 + 480 Гц вместе, мягкая атака, повтор через 2,6 с", () => {
    expect(BRIGADE_RING_TONES.length).toBeGreaterThanOrEqual(2);
    BRIGADE_RING_TONES.forEach((tone, index) => {
      expect(tone.hz).toEqual([440, 480]);
      expect(tone.at).toBeCloseTo(index * RING_PERIOD_S);
      expect(tone.attack).toBe(RING_ATTACK_S);
      // Тон кончается до следующего повтора: между трелями — тишина.
      expect(tone.seconds).toBeLessThan(RING_PERIOD_S);
    });
    expect(RING_PERIOD_S).toBe(2.6);
    expect(RING_ATTACK_S).toBeGreaterThanOrEqual(0.05);
  });

  it("сигнал карточки и тревога — другие частоты и короткие тоны без мягкой атаки", () => {
    const ringHz = new Set(BRIGADE_RING_TONES.flatMap((tone) => tone.hz));
    for (const tones of [NEW_CARD_TONES, ALARM_TONES])
      for (const tone of tones) {
        expect(tone.hz.some((hz) => ringHz.has(hz))).toBe(false);
        expect(tone.seconds).toBeLessThan(0.5);
        expect(tone.attack).toBeLessThan(RING_ATTACK_S);
      }
    expect(NEW_CARD_TONES.map((tone) => tone.hz)).toEqual([[880], [880]]);
  });

  it("сигналы звучат один раз и гаснут: трель — до 4 с, карточка — до 0,5 с", () => {
    expect(end(BRIGADE_RING_TONES)).toBeLessThanOrEqual(4);
    expect(end(NEW_CARD_TONES)).toBeLessThanOrEqual(0.5);
    for (const tones of [BRIGADE_RING_TONES, NEW_CARD_TONES, ALARM_TONES])
      for (const tone of tones) expect(tone.attack).toBeLessThan(tone.seconds);
  });

  // TC-06: сигналы срочности — двойной бип «осталось 10 с» и низкий «просрочено».
  it("срочность: двойной бип и один низкий тон на частотах, которых нет у других сигналов", () => {
    expect(URGENCY_WARN_TONES).toHaveLength(2);
    expect(URGENCY_OVER_TONES).toHaveLength(1);
    const others = new Set(
      [...BRIGADE_RING_TONES, ...NEW_CARD_TONES, ...ALARM_TONES].flatMap(
        (tone) => tone.hz,
      ),
    );
    // 425 Гц — гудок софтфона (softphone/tones.ts).
    others.add(425);
    for (const tone of [...URGENCY_WARN_TONES, ...URGENCY_OVER_TONES])
      expect(tone.hz.some((hz) => others.has(hz))).toBe(false);
    // «Просрочено» ниже бипа: на слух не спутать.
    expect(
      Math.max(...URGENCY_OVER_TONES.flatMap((tone) => tone.hz)),
    ).toBeLessThan(Math.min(...URGENCY_WARN_TONES.flatMap((tone) => tone.hz)));
  });

  it("срочность звучит один раз и гаснет: бип до 0,5 с, низкий тон до 0,6 с", () => {
    expect(end(URGENCY_WARN_TONES)).toBeLessThanOrEqual(0.5);
    expect(end(URGENCY_OVER_TONES)).toBeLessThanOrEqual(0.6);
    for (const tone of [...URGENCY_WARN_TONES, ...URGENCY_OVER_TONES])
      expect(tone.attack).toBeLessThan(tone.seconds);
  });
});
