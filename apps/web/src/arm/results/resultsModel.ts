// Результаты обучаемого (T-031): чистая логика без React и сети.
// Баллы не пересчитываются — их выдаёт сервер (ответ капитана §2). Здесь только
// факты по карточке: путь статусов и служба; время — из серверного разбора.
import type { components } from "../../api-client/schema";
import { isClosed, STATE_LABELS, type CardState } from "../cardModel";
import {
  formatScore,
  hasScore,
  readable,
  type Evaluation,
} from "../../teacher/console/model";
import type { AttemptAnalysis } from "../useAnalysis";
import { attemptVerdict, verdictHeading, type AttemptVerdict } from "./debrief";

type Card = components["schemas"]["Card"];
type StoredEvent = components["schemas"]["StoredEvent"];

/**
 * Цикл по памятке ДДС (стр. 22–25): принять, по ходу работ отмечать этапы,
 * завершить. Этапы между принятием и завершением необязательны — их набор задаёт
 * эталон сценария; это правило жизненного цикла, а не эталон конкретного задания.
 */
export const REGULATION_PATH: CardState[] = ["accepted", "completed"];

/**
 * Чем по правилам закрывают карточку этого сценария — последний статус эталона из разбора
 * («Эталон: … → Отказ от выполнения работ»). Памятка ДДС закрывает карточку и «Работами
 * завершены», и «Отказом от выполнения работ»; без эталона — «Работы завершены».
 */
export function regulationEnd(
  criteria: readonly { key: string; evidence: string[] }[],
): CardState {
  const line = criteria
    .find((item) => item.key === "status_flow")
    ?.evidence.map(readable)
    .find((text) => text.startsWith("Эталон"));
  const last = line?.split("→").pop()?.trim();
  const state = (Object.keys(STATE_LABELS) as CardState[]).find(
    (key) => STATE_LABELS[key] === last,
  );
  return state ?? "completed";
}

/** Строка «По правилам» в таблице разбора. */
export function regulationText(end: CardState = "completed"): string {
  return end === "completed" || end === "refused"
    ? `Принята → этапы по ходу работ (начало реагирования, прибытие, проведение работ) → ${STATE_LABELS[end]}`
    : STATE_LABELS[end];
}

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
  // Тренировки-показы (`settings_snapshot.demo`, HQ-034): карточку вёл курсор — не попытка.
  demoSessions: ReadonlySet<string> = new Set(),
): SessionGroup[] {
  const byCard = new Map(evaluations.map((item) => [item.card_id, item]));
  const shown = cards
    .filter((card) => !demoSessions.has(card.session_id))
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

/**
 * Прошла ли карточка цикл: была принята и закрыта тем статусом, которым её закрывает эталон
 * (`regulationEnd`). Эталон без принятия («Не принята», «Перенаправлена») — решение без цикла.
 */
export function fullCycle(
  path: CardState[],
  end: CardState = "completed",
): boolean {
  const cycle = end === "completed" || end === "refused";
  return (!cycle || path.includes("accepted")) && path[path.length - 1] === end;
}

/**
 * Комментарии диспетчера по карточке, которые читает оценка (`evalcore` `_all_comments`):
 * каждый статус затирает текущий комментарий, а ключевые сведения пишут при «Принята».
 */
export function statusComments(
  events: StoredEvent[],
  current: string,
): { status: string | null; text: string }[] {
  const found: { status: string | null; text: string }[] = [];
  for (const event of events) {
    if (!["status_change", "redirect", "comment"].includes(event.type))
      continue;
    const payload = event.payload as { state?: CardState; comment?: unknown };
    const text = typeof payload.comment === "string" ? payload.comment : "";
    if (!text.trim() || found.some((item) => item.text === text)) continue;
    const status =
      event.type === "redirect"
        ? STATE_LABELS.redirected
        : payload.state
          ? STATE_LABELS[payload.state]
          : null;
    found.push({ status, text });
  }
  if (current.trim() && !found.some((item) => item.text === current))
    found.push({ status: null, text: current });
  return found;
}

export interface ResultsSummary {
  closed: number;
  interrupted: number;
  scored: number;
  passed: number;
  verdictsReady: number;
  reactionInNorm: number;
  reactionKnown: number;
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
    // Пока итоговый разбор не загрузился, зачёт не утверждаем по автоматическому
    // баллу: решение преподавателя ещё может его изменить.
    passed: rows.filter((row) => {
      const analysis = analyses.get(row.card.id);
      return rowVerdict(row, analysis)?.passed;
    }).length,
    verdictsReady: rows.filter((row) =>
      rowVerdict(row, analyses.get(row.card.id)),
    ).length,
    reactionInNorm: rows.filter((row) => {
      return analyses.get(row.card.id)?.timing?.reaction_overdue === false;
    }).length,
    reactionKnown: rows.filter(
      (row) => analyses.get(row.card.id)?.timing?.reaction_overdue != null,
    ).length,
    withComment: rows.filter((row) =>
      Boolean(row.evaluation?.teacher_comment.trim()),
    ).length,
  };
}

/** Разбор относится именно к показанной версии оценки, а не к старому ответу API. */
export function currentEvaluationAnalysis(
  row: ResultRow,
  analysis: AttemptAnalysis | undefined,
): NonNullable<AttemptAnalysis["evaluation"]> | null {
  const evaluation = row.evaluation;
  const details = analysis?.evaluation;
  return evaluation &&
    details?.evaluation_id === evaluation.id &&
    details.evaluation_version === evaluation.version &&
    Math.abs(details.effective_total - evaluation.total) <= 0.00001
    ? details
    : null;
}

/** Балл попытки в списке — только из согласованного с оценкой разбора. */
export function rowScore(
  row: ResultRow,
  analysis: AttemptAnalysis | undefined,
): number | null {
  if (!row.evaluation || !hasScore(row.evaluation)) return null;
  return currentEvaluationAnalysis(row, analysis)?.effective_total ?? null;
}

/** Вердикт попытки для списка и счётчиков — по тем же правилам, что в разборе. */
export function rowVerdict(
  row: ResultRow,
  analysis: AttemptAnalysis | undefined,
): AttemptVerdict | null {
  if (!row.evaluation || !hasScore(row.evaluation)) return null;
  const details = currentEvaluationAnalysis(row, analysis);
  if (
    !details ||
    (details.status !== "complete" && !details.effective_override)
  )
    return null;
  const override = details.effective_override;
  return attemptVerdict(
    details.effective_total,
    row.evaluation.criteria,
    override?.decision === "disagree" ? override.new_total : null,
  );
}

/** Подпись в списке: не называем автоматический балл окончательным решением. */
export function rowLabel(
  row: ResultRow,
  analysis: AttemptAnalysis | undefined,
): string {
  const verdict = rowVerdict(row, analysis);
  const details = currentEvaluationAnalysis(row, analysis);
  if (verdict && details) {
    const pending =
      details.status === "partial" ? " · проверка продолжается" : "";
    return `${verdictHeading(verdict, details.effective_override?.decision ?? null)} · ${formatScore(details.effective_total)}${pending}`;
  }
  if (
    details?.status === "partial" &&
    row.evaluation &&
    hasScore(row.evaluation)
  )
    return `Автоматическая оценка: ${formatScore(details.automatic_total)} · проверка продолжается`;
  if (row.evaluation && hasScore(row.evaluation))
    // GET /evaluations возвращает уже изменённый преподавателем total. Без
    // разбора нельзя честно назвать этот балл автоматическим или окончательным.
    return "Балл и решение преподавателя загружаются";
  if (row.evaluation) return "Оценщик пока не вернул балл";
  return row.interrupted ? "прервана" : "разбор готовится";
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
