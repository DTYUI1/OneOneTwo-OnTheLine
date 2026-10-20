// Шкала громкости записи в ряду ответа телефона (макет docs/dds_training_review/phone/):
// 16 делений, норма отмечена зелёным снизу, после нормы — громко (оранжевые деления).

export const METER_SEGMENTS = 16;
/** Первое деление нормы и первое «громкое» деление (с нуля). */
const NORM_FROM = 5;
const LOUD_FROM = 12;

export type MeterZone = "quiet" | "ok" | "loud";

/** Сколько делений горит при уровне 0…1. */
export function litSegments(level: number): number {
  return Math.max(
    0,
    Math.min(METER_SEGMENTS, Math.round(level * METER_SEGMENTS)),
  );
}

/** Зона деления шкалы. */
export function segmentZone(index: number): MeterZone {
  return index < NORM_FROM ? "quiet" : index < LOUD_FROM ? "ok" : "loud";
}

/** Где оказался пик фразы: верхнее горевшее деление (GP-24: «записано в норме»). */
export function peakZone(level: number): MeterZone {
  const lit = litSegments(level);
  return lit === 0 ? "quiet" : segmentZone(lit - 1);
}
