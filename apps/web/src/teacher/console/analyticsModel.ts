// Аналитика занятия с сервера (GET /reports/session/{id}/analytics, C-06): время по
// методике занятия, слои оценки, ошибки по категориям, рекомендация. Здесь только
// подписи и выбор, что показать; средние и итоги считает сервер.
import type { components } from "../../api-client/schema";

export type SessionAnalytics = components["schemas"]["SessionAnalytics"];
export type TraineeAnalytics = SessionAnalytics["trainees"][number];
export type AttemptAnalysis = SessionAnalytics["attempts"][number];
type ErrorCounts = TraineeAnalytics["errors"];
type Layer = NonNullable<AttemptAnalysis["evaluation"]>["layers"][number];

export const ERROR_LABELS: Record<keyof ErrorCounts, string> = {
  input: "ввод",
  address: "адрес",
  grammar: "грамотность",
  routing: "маршрутизация",
  status_flow: "статусы",
  timing: "время",
  call: "звонок",
};

export const LAYER_LABELS: Record<Layer["layer"], string> = {
  rules: "правила",
  address: "адрес",
  grammar: "грамотность",
  semantic: "смысл доклада",
  llm: "ИИ-оценка текста",
  information: "сведения бригады",
};

export const LAYER_STATUS_LABELS: Record<Layer["status"], string> = {
  done: "выполнен",
  pending: "ожидает",
  unavailable: "не подключён",
  failed: "сбой",
  not_applicable: "не требуется",
};

export const DIRECTION_LABELS = {
  increase: "повысить до",
  keep: "оставить",
  decrease: "понизить до",
} as const;

/** Ошибки по категориям: null — не измерялось (не показываем), 0 — ошибок нет. */
export function errorSummary(errors: ErrorCounts): string[] {
  return (Object.keys(ERROR_LABELS) as (keyof ErrorCounts)[])
    .filter((key) => (errors[key] ?? 0) > 0)
    .map((key) => `${ERROR_LABELS[key]}: ${errors[key]}`);
}

export interface TimeValue {
  seconds: number | null;
  /** true — достоверного среднего нет, показано оценочное значение попытки. */
  estimated: boolean;
  /** Оценочные значения попыток, если их несколько: усреднять их сами не берёмся. */
  values: number[];
}

/**
 * Чей это заход: сервер отдаёт в попытке внутренний ID участия, а не user UUID
 * (docs/DWOTS_FINDINGS.md) — сопоставляем через карточку: card_id → trainee_id.
 */
export function attemptOwner(
  cards: { id: string; trainee_id: string }[],
): (attempt: AttemptAnalysis) => string {
  const byCard = new Map(cards.map((card) => [card.id, card.trainee_id]));
  return (attempt) => byCard.get(attempt.card_id) ?? attempt.participant_id;
}

/**
 * Время места для таблицы и графика. Среднее сервер считает только по достоверным
 * измерениям; если их нет, берём оценочное значение единственной попытки, а при
 * нескольких — перечисляем их без усреднения.
 */
export function traineeTime(
  trainee: Pick<
    TraineeAnalytics,
    "user_id" | "mean_reaction_s" | "mean_handling_s"
  >,
  attempts: AttemptAnalysis[],
  kind: "reaction" | "handling",
  ownerOf: (attempt: AttemptAnalysis) => string = (attempt) =>
    attempt.participant_id,
): TimeValue | null {
  const mean =
    kind === "reaction" ? trainee.mean_reaction_s : trainee.mean_handling_s;
  if (mean !== null) return { seconds: mean, estimated: false, values: [] };
  const values = attempts
    .filter((attempt) => ownerOf(attempt) === trainee.user_id)
    .map((attempt) =>
      kind === "reaction"
        ? attempt.timing.reaction_s
        : attempt.timing.timing_version === 3
          ? attempt.timing.active_handling_s
          : attempt.timing.handling_s,
    )
    .filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  if (values.length === 1)
    return { seconds: values[0], estimated: true, values };
  return { seconds: null, estimated: true, values };
}

/** Слои, из-за которых оценка предварительная, — для короткой строки. */
export function openLayers(attempt: AttemptAnalysis): string[] {
  return (attempt.evaluation?.layers ?? [])
    .filter((layer) => layer.status === "pending" || layer.status === "failed")
    .map(
      (layer) =>
        `${LAYER_LABELS[layer.layer]} — ${LAYER_STATUS_LABELS[layer.status]}`,
    );
}

export type SessionLifecycle = components["schemas"]["SessionLifecycle"];
type AttemptState = SessionLifecycle["attempts"][number];

export const RECORDING_LABELS: Record<
  AttemptState["recording_status"],
  string
> = {
  none: "записи нет",
  recording: "идёт запись",
  upload_pending: "запись ещё выгружается",
  saved: "запись сохранена",
  failed: "запись не сохранилась",
};

export interface Interrupted {
  cardId: string;
  traineeId: string;
  at: string | null;
  recording: string;
}

/**
 * Итог завершения занятия по lifecycle (C-03): попытки, прерванные завершением,
 * и отменённые невыданные задания. Владелец попытки — по карточке, как в аналитике.
 */
export function finishSummary(
  lifecycle: Pick<SessionLifecycle, "attempts" | "cancelled_assignment_ids">,
  cards: { id: string; trainee_id: string }[],
): { interrupted: Interrupted[]; cancelled: number } {
  const byCard = new Map(cards.map((card) => [card.id, card.trainee_id]));
  return {
    interrupted: lifecycle.attempts
      .filter((attempt) => attempt.status === "interrupted")
      .map((attempt) => ({
        cardId: attempt.card_id,
        traineeId: byCard.get(attempt.card_id) ?? attempt.participant_id,
        at: attempt.interrupted_at,
        recording: RECORDING_LABELS[attempt.recording_status],
      })),
    cancelled: lifecycle.cancelled_assignment_ids.length,
  };
}
