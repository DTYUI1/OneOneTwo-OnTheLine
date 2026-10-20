export const HANDLING_NORMATIVE_ERROR =
  "Введите время в формате мм:сс, от 0:01 до 60:00 (например, 3:00).";

export const HANDLING_NORMATIVE_HINT =
  "Сверх этого времени балл за время снижается. Ожидание доклада бригады не считается.";

export function parseHandlingNormative(value: string): number | null {
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  const seconds = Number(match[1]) * 60 + Number(match[2]);
  return seconds >= 1 && seconds <= 3600 ? seconds : null;
}

export function formatHandlingNormative(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
