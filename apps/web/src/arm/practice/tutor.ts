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
  /** Номер своей службы: звонок на него — доклад диспетчеру службы. */
  readonly servicePhone: string | null;
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
  /**
   * Карточка принята, а адрес диспетчер не вписал. Адрес — критический критерий:
   * без него попытка не зачтена, поэтому напоминаем, не дожидаясь разбора.
   */
  readonly addressMissing: boolean;
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
  "report",
  "responding",
  "arrived",
  "working",
  "completed",
];

/**
 * Доклад диспетчеру службы состоялся: номер службы набран, абонент ответил и
 * разговор закончен. По одному ответу шаг не закрываем: иначе проводник зовёт
 * к бригаде, пока обучаемый ещё докладывает службе.
 */
function reportedToService(
  events: readonly TutorEvent[],
  phone: string | null,
): boolean {
  if (!phone) return false;
  const dialed = new Set(
    events
      .filter((e) => e.type === "call_dial" && e.payload.phone_ext === phone)
      .map((e) => String(e.payload.call_id)),
  );
  const answered = new Set<string>();
  for (const e of events) {
    const id = String(e.payload.call_id);
    if (!dialed.has(id)) continue;
    if (e.type === "call_answer") answered.add(id);
    else if (
      (e.type === "call_hangup" || e.type === "call_end") &&
      answered.has(id)
    )
      return true;
  }
  return false;
}

/** Адрес вписан в блок «Адрес — ввод диспетчера» (field_change с полем address). */
function addressEntered(events: readonly TutorEvent[]): boolean {
  return events.some(
    (e) => e.type === "field_change" && e.payload.field === "address",
  );
}

export function tutorProgress(input: TutorInput): TutorProgress {
  const rank = RANK[input.state] ?? 0;
  const finished = rank >= 5;
  const done = new Set<WorkflowStepId>(["open"]);
  if (rank >= 1) done.add("decide");
  if (input.events.some((e) => e.type === "brigades_select"))
    done.add("brigade");
  if (reportedToService(input.events, input.servicePhone)) done.add("report");
  if (rank >= 2) done.add("responding");
  if (rank >= 3) done.add("arrived");
  if (rank >= 4) done.add("working");
  if (finished) done.add("completed");
  // Ход дела ведёт статус: ушёл вперёд — проводник идёт за учеником, а пропущенное
  // (например, доклад службе) остаётся напоминанием, а не стеной.
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
    addressMissing: rank >= 1 && !addressEntered(input.events),
  };
}
