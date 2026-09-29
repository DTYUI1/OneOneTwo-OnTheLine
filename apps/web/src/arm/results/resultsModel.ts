// Результаты обучаемого (T-031): чистая логика без React и сети.
// Баллы не пересчитываются — их выдаёт сервер (ответ капитана §2). Здесь только
// факты по карточке: путь статусов и служба; время — из серверного разбора.
import type { components } from "../../api-client/schema";
import { isClosed, STATE_LABELS, type CardState } from "../cardModel";
import { hasScore, type Evaluation } from "../../teacher/console/model";
import type { AttemptAnalysis } from "../useAnalysis";
import { attemptVerdict, type AttemptVerdict } from "./debrief";

type Card = components["schemas"]["Card"];
type StoredEvent = components["schemas"]["StoredEvent"];

/**
 * Цикл по памятке ДДС (стр. 22–25): принять, по ходу работ отмечать этапы,
 * завершить. Этапы между принятием и завершением необязательны — их набор задаёт
 * эталон сценария; это правило жизненного цикла, а не эталон конкретного задания.
 */
export const REGULATION_PATH: CardState[] = ["accepted", "completed"];
export const REGULATION_TEXT =
  "Принята → этапы по ходу работ (начало реагирования, прибытие, проведение работ) → Работы завершены";

export interface ResultRow {
  card: Card;
  evaluation: Evaluation | null;
  /** Карточка не закрыта, а занятие завершено — попытку прервало завершение (C-03). */
  interrupted: boolean;
}

export interface SessionGroup {
  sessionId: string;
  rows: ResultRow[];
}

/**
 * Закрытые карточки с вердиктами, по занятиям: новое занятие и новая карточка — выше.
 * Незакрытые идущего занятия сюда не попадают: разбирать ещё нечего. Незакрытые
 * завершённого занятия — прерванные попытки: обучаемый видит, что их прервали.
 */
export function groupResults(
  cards: Card[],
  evaluations: Evaluation[],
  finishedSessions: ReadonlySet<string> = new Set(),
): SessionGroup[] {
  const byCard = new Map(evaluations.map((item) => [item.card_id, item]));
  const shown = cards
    .filter((card) => isClosed(card) || finishedSessions.has(card.session_id))
    .sort((a, b) => closedAt(b) - closedAt(a));
  const groups: SessionGroup[] = [];
  for (const card of shown) {
    const row = {
      card,
      evaluation: byCard.get(card.id) ?? null,
      interrupted: !isClosed(card),
    };
    const group = groups.find((item) => item.sessionId === card.session_id);
    if (group) group.rows.push(row);
    else groups.push({ sessionId: card.session_id, rows: [row] });
  }
  return groups;
}

function closedAt(card: Card): number {
  return Date.parse(card.closed_at ?? card.appeared_at);
}

/** Статусы, которые обучаемый поставил, по порядку событий. */
export function statusPath(events: StoredEvent[]): CardState[] {
  return events
    .filter((event) => event.type === "status_change")
    .map((event) => (event.payload as { state?: CardState }).state)
    .filter((state): state is CardState => Boolean(state));
}

export function formatPath(path: CardState[]): string {
  return path.length === 0
    ? "статусов не ставили"
    : path.map((state) => STATE_LABELS[state]).join(" → ");
}

/** Прошла ли карточка цикл: была принята и завершена «Работы завершены». */
export function fullCycle(path: CardState[]): boolean {
  return path.includes("accepted") && path[path.length - 1] === "completed";
}

export interface ResultsSummary {
  closed: number;
  interrupted: number;
  scored: number;
  passed: number;
  reactionInNorm: number;
  withComment: number;
}

/**
 * Счётчики для шапки. Средний балл не считаем: агрегаты оценок — дело сервера.
 * Реакция — из разбора сервера по методике занятия; без разбора попытка в счёт
 * «в нормативе» не идёт.
 */
export function summarize(
  groups: SessionGroup[],
  analyses: Map<string, AttemptAnalysis>,
): ResultsSummary {
  const all = groups.flatMap((group) => group.rows);
  // Счётчики — по закрытым карточкам; прерванные считаются отдельно.
  const rows = all.filter((row) => !row.interrupted);
  return {
    closed: rows.length,
    interrupted: all.length - rows.length,
    scored: rows.filter((row) => row.evaluation && hasScore(row.evaluation))
      .length,
    passed: rows.filter(
      (row) => rowVerdict(row, analyses.get(row.card.id))?.passed,
    ).length,
    reactionInNorm: rows.filter((row) => {
      const timing = analyses.get(row.card.id)?.timing;
      return (
        timing?.reaction_s != null &&
        timing.reaction_s <= timing.reaction_normative_s
      );
    }).length,
    withComment: rows.filter((row) =>
      Boolean(row.evaluation?.teacher_comment.trim()),
    ).length,
  };
}

/** Балл попытки в списке — тот же, что в разборе: с учётом решения преподавателя. */
export function rowScore(
  row: ResultRow,
  analysis: AttemptAnalysis | undefined,
): number | null {
  return analysis?.evaluation?.effective_total ?? row.evaluation?.total ?? null;
}

/** Вердикт попытки для списка и счётчиков — по тем же правилам, что в разборе. */
export function rowVerdict(
  row: ResultRow,
  analysis: AttemptAnalysis | undefined,
): AttemptVerdict | null {
  if (!row.evaluation || !hasScore(row.evaluation)) return null;
  const override = analysis?.evaluation?.effective_override;
  return attemptVerdict(
    rowScore(row, analysis) ?? 0,
    row.evaluation.criteria,
    override?.decision === "disagree" ? override.new_total : null,
  );
}

/** «Карточек пока нет» — только когда обе загрузки удались, иначе это ошибка связи. */
export function isEmptyState(
  cardsLoaded: boolean,
  evaluationsLoaded: boolean,
  count: number,
): boolean {
  return cardsLoaded && evaluationsLoaded && count === 0;
}

/**
 * Ступень тренировки — из заголовка «Тренировка: ступень N — …» (его ставит
 * apps/api/app/api/sessions/practice.py; формат закреплён тестом test_progress.py).
 * В снимок настроек номер не пишем: контракт Settings запрещает лишние поля.
 * Нет ступени — обучающее упражнение.
 */
export function practiceStepOf(session: {
  title?: string;
}): number | undefined {
  const match = session.title?.match(/ступень (\d)/i);
  return match ? Number(match[1]) : undefined;
}
