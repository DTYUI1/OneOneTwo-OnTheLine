// Проводник тренировки: какой шаг порядка работы сейчас. Чистая функция без React —
// шаг выводится из того, что уже сделано в карточке (статус и журнал действий),
// поэтому после перезагрузки страницы проводник продолжает с того же места.
// Ошибку он не блокирует (эталон зоны софтфона): лишь говорит, что ожидается.
import type { Card } from "../../shared/api";
import type { WorkflowStepId } from "../../shared/workflow";

/** Минимум события журнала, нужный проводнику. */
export interface TutorEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

export interface TutorInput {
  readonly state: Card["state"];
  readonly events: readonly TutorEvent[];
}

export interface TutorProgress {
  /** Текущий шаг — следующий после последнего сделанного; null — упражнение закончено. */
  readonly current: WorkflowStepId | null;
  /** Шаги до текущего, которые ученик пропустил: напоминаем, но не держим на них. */
  readonly missed: readonly WorkflowStepId[];
  readonly done: ReadonlySet<WorkflowStepId>;
  /** Карточка закрыта «Работы завершены» или отказом бригады. */
  readonly finished: boolean;
  /** Поставлено «Не принята»: в упражнении карточку нужно принять. */
  readonly rejected: boolean;
}

// Ход дела: статус этого ранга или дальше закрывает шаг.
const RANK: Partial<Record<Card["state"], number>> = {
  accepted: 1,
  responding: 2,
  arrived: 3,
  working: 4,
  completed: 5,
  refused: 5,
};

const ORDER: readonly WorkflowStepId[] = [
  "open",
  "decide",
  "brigade",
  "responding",
  "arrived",
  "working",
  "completed",
];

const DISPATCH_EVENTS = new Set(["brigade_briefing", "brigades_select"]);

export function tutorProgress(input: TutorInput): TutorProgress {
  const rank = RANK[input.state] ?? 0;
  const finished = rank >= 5;
  const done = new Set<WorkflowStepId>(["open"]);
  if (rank >= 1) done.add("decide");
  // Бригаду направляет вводная в разговоре (GP-05); выбор — в журналах до неё.
  if (input.events.some((e) => DISPATCH_EVENTS.has(e.type)))
    done.add("brigade");
  if (rank >= 2) done.add("responding");
  if (rank >= 3) done.add("arrived");
  if (rank >= 4) done.add("working");
  if (finished) done.add("completed");
  // Ход дела ведёт статус: ушёл вперёд — проводник идёт за учеником, а пропущенное
  // (например, направление бригады) остаётся напоминанием, а не стеной.
  const last = Math.max(
    ...ORDER.map((id, index) => (done.has(id) ? index : 0)),
  );
  const current = finished ? null : (ORDER[last + 1] ?? null);
  return {
    current,
    missed: ORDER.slice(0, last + 1).filter((id) => !done.has(id)),
    done,
    finished,
    rejected: input.state === "rejected",
  };
}
