// Экран результатов тренировок 112 (просьба капитана 29.09): сводка по звонкам и выход.
// Выход из 112 ведёт сюда, крестик отсюда — к выбору обучения («112» или «Диспетчер
// служб»); у преподавателя и администратора выбора нет — в их раздел.
import type { User } from "../shared/api";
import { CHOOSE_TRAINING } from "../shared/WelcomeGate";
import type { AttemptSummary } from "./save";

export const RESULTS_PATH = "/operator/results";

/** Раздел роли без выбора обучения — куда раньше вёл выход из 112. */
const CABINET: Record<string, string> = {
  teacher: "/teacher",
  admin: "/admin",
};

/** Куда ведёт крестик экрана результатов. */
export function exitTarget(role: User["role"]): {
  readonly to: string;
  readonly state?: typeof CHOOSE_TRAINING;
} {
  const cabinet = CABINET[role];
  return cabinet ? { to: cabinet } : { to: "/arm", state: CHOOSE_TRAINING };
}

export interface CallSummary {
  readonly scenarioId: string;
  readonly title: string;
  readonly count: number;
  readonly best: number;
  readonly last: number;
  readonly max: number;
}

export interface Summary {
  readonly count: number;
  /** Средний и лучший балл в процентах от максимума; null — попыток нет. */
  readonly average: number | null;
  readonly best: number | null;
  readonly calls: readonly CallSummary[];
}

const percent = (attempt: AttemptSummary) =>
  attempt.max_total > 0 ? (attempt.total / attempt.max_total) * 100 : 0;

/**
 * Сводка по попыткам (сервер отдаёт их новыми сверху): всего, средний и лучший процент, по
 * каждому звонку — сколько раз, лучший и последний балл. Звонки — в порядке последней
 * тренировки.
 */
export function summarize(attempts: readonly AttemptSummary[]): Summary {
  const calls = new Map<string, CallSummary>();
  for (const attempt of attempts) {
    const seen = calls.get(attempt.scenario_id);
    calls.set(attempt.scenario_id, {
      scenarioId: attempt.scenario_id,
      title: seen?.title ?? attempt.scenario_title,
      count: (seen?.count ?? 0) + 1,
      best: Math.max(seen?.best ?? 0, attempt.total),
      last: seen?.last ?? attempt.total,
      max: seen?.max ?? attempt.max_total,
    });
  }
  const shares = attempts.map(percent);
  return {
    count: attempts.length,
    average: shares.length
      ? Math.round(
          shares.reduce((sum, value) => sum + value, 0) / shares.length,
        )
      : null,
    best: shares.length ? Math.round(Math.max(...shares)) : null,
    calls: [...calls.values()],
  };
}
