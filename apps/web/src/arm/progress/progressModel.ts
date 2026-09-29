// «Мой путь» (29.09): ступени обучения с сервера (GET /progress, правило —
// evalcore/progress.py). Здесь только слова: состояние ступени и что осталось.
import type { components } from "../../api-client/schema";

export type StepProgress = components["schemas"]["StepProgressView"];
export type StepState = "passed" | "current" | "open" | "locked";

export const STATE_LABELS: Record<StepState, string> = {
  passed: "пройдена",
  current: "текущая",
  open: "открыта",
  locked: "закрыта",
};

export function stepState(step: StepProgress, current: number): StepState {
  if (step.passed) return "passed";
  if (!step.unlocked) return "locked";
  return step.number === current ? "current" : "open";
}

/** Что осталось до прохождения ступени — словами. */
export function remaining(step: StepProgress): string {
  if (step.passed) return "Ступень пройдена.";
  if (!step.unlocked)
    return `Откроется, когда будет пройдена ступень ${step.number - 1}.`;
  const left = step.required - step.streak;
  if (step.required === 1) return "Пройдите тренировку и получите «Зачтено».";
  return `Зачтено подряд ${step.streak} из ${step.required}: осталось ${left} ${cards(left)} без критических ошибок.`;
}

/** Что делать дальше: текущая ступень; всё пройдено — закреплять на последней. */
export function nextAction(steps: readonly StepProgress[]): {
  step: StepProgress;
  done: boolean;
} {
  const current = steps.find((step) => step.unlocked && !step.passed);
  if (current) return { step: current, done: false };
  return { step: steps[steps.length - 1], done: true };
}

/** Ширина полосы ступени в процентах: без NaN при required = 0 и не больше 100. */
export function barWidth(value: number, required: number): number {
  return Math.min(100, (value / Math.max(1, required)) * 100);
}

// Ступеней в evalcore/progress.py (STEPS).
const STEP_COUNT = 4;

/** Строка для итогов попытки: как карточка сдвинула обучаемого по ступени. */
export function attemptProgressLine(
  step: StepProgress,
  verdict: { passed: boolean },
): string {
  const next = step.number + 1;
  if (step.passed && verdict.passed)
    return step.number >= STEP_COUNT
      ? `Ступень ${step.number} пройдена — все ступени пройдены`
      : `Ступень ${step.number} пройдена — открыта ступень ${next}`;
  if (!verdict.passed)
    return step.passed
      ? `Ступень ${step.number} уже пройдена: эта ошибка её не отменяет`
      : `Ряд начат заново: нужно ${step.required} подряд`;
  const left = step.required - step.streak;
  const more = left === 1 ? "ещё одна карточка" : `ещё ${left} ${cards(left)}`;
  return `Ступень ${step.number}: зачтено подряд ${step.streak} из ${step.required} — ${more}`;
}

export function cards(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  if (tens >= 11 && tens <= 14) return "карточек";
  if (ones === 1) return "карточка";
  if (ones >= 2 && ones <= 4) return "карточки";
  return "карточек";
}
