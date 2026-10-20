// Ход работы локального ИИ: генерация заданий и ИИ-проверка комментариев.
// Модель одна, задачи идут по очереди — экраны показывают, где сейчас очередь.
import type { components } from "../api-client/schema";

type Evaluation = components["schemas"]["Evaluation"];
export type GenerationState = components["schemas"]["AIPreparation"]["state"];

export const GENERATION_LABELS: Record<GenerationState, string> = {
  waiting: "Ожидает окончания занятия",
  queued: "В очереди к ИИ",
  generating: "Генерируется",
  ready: "Готово",
  failed: "Ошибка подготовки",
  stopping: "Останавливаем…",
  cancelled: "Остановлено",
};

/** Идёт или ждёт: полоса двигается, время до конца считается. */
export function generationActive(state: GenerationState): boolean {
  return (
    state === "waiting" ||
    state === "queued" ||
    state === "generating" ||
    state === "stopping"
  );
}

/** Отметка хода генерации: когда стало готово столько-то заданий. */
export interface ProgressMark {
  at: number;
  completed: number;
}

/** Оценка по скорости текущего запуска, до первого результата — по замеру сервера. */
export function itemMilliseconds(
  start: ProgressMark,
  last: ProgressMark,
  expectedSeconds?: number | null,
): number | null {
  const made = last.completed - start.completed;
  if (made > 0 && last.at > start.at) return (last.at - start.at) / made;
  return expectedSeconds && expectedSeconds > 0 ? expectedSeconds * 1000 : null;
}

export function secondsLeft(
  start: ProgressMark,
  last: ProgressMark,
  total: number,
  now: number,
  expectedSeconds?: number | null,
): number | null {
  if (last.completed >= total) return 0;
  const perItem = itemMilliseconds(start, last, expectedSeconds);
  if (perItem === null) return null;
  return Math.max(
    0,
    (perItem * (total - last.completed) - Math.max(0, now - last.at)) / 1000,
  );
}

/** Время двигает текущий шаг; 100% означает только фактически готовый пакет. */
export function generationPercent(
  start: ProgressMark,
  last: ProgressMark,
  total: number,
  now: number,
  expectedSeconds?: number | null,
): number {
  if (total <= 0) return 0;
  if (last.completed >= total) return 100;
  const perItem = itemMilliseconds(start, last, expectedSeconds);
  const fraction = perItem
    ? Math.min(0.95, Math.max(0, now - last.at) / perItem)
    : 0;
  return Math.min(95, (100 * (last.completed + fraction)) / total);
}

export function formatLeft(seconds: number | null): string {
  if (seconds === null) return "оцениваем время…";
  if (seconds < 5) return "почти готово";
  if (seconds < 60) return `осталось ≈ ${Math.ceil(seconds / 5) * 5} с`;
  return `осталось ≈ ${Math.ceil(seconds / 60)} мин`;
}

/** Подпись ИИ-проверки оценки для преподавателя: с числом задач ИИ впереди. */
export function checkLabel(evaluation: Evaluation): string {
  if (evaluation.status === "complete") return "оценка готова";
  const check = evaluation.ai_check ?? null;
  if (check?.state === "running") return "ИИ проверяет…";
  if (check?.state === "queued")
    return check.ahead === 0
      ? "ждёт ИИ-проверки"
      : `ждёт ИИ-проверки · впереди ${check.ahead}`;
  if (check?.state === "failed") return "ИИ-проверка не удалась";
  return "предварительно";
}

/**
 * То же для обучаемого — без места в очереди: ему важно только, что оценка ещё
 * уточняется и почему.
 */
export function traineeCheckNote(evaluation: Evaluation): string {
  const state = evaluation.ai_check?.state;
  if (state === "running") return "ИИ проверяет комментарий…";
  if (state === "queued") return "ждёт ИИ-проверки";
  return "оценка уточняется";
}

/** Проверка ещё идёт или ждёт — состояние меняется без событий, опрашиваем чаще. */
export function checksPending(evaluations: Evaluation[] | undefined): boolean {
  return (evaluations ?? []).some(
    (item) =>
      item.status !== "complete" &&
      (item.ai_check?.state === "queued" || item.ai_check?.state === "running"),
  );
}
