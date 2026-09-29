// Отчёты D-02: чистая логика без React и сети. Все цифры — из ответов сервера
// (отчёт занятия, вердикты, карточки); баллы и время здесь не пересчитываются,
// только сопоставляются с нормативами снимка занятия и группируются.
import { attemptVerdict } from "../../arm/results/debrief";
import { isClosed } from "../../arm/cardModel";
import {
  errorSummary,
  traineeTime,
  type SessionAnalytics,
  type TraineeAnalytics,
} from "./analyticsModel";
import {
  criterionLabel,
  hasScore,
  readable,
  type Card,
  type Evaluation,
  type Report,
  type Session,
} from "./model";

export type ReportRow = Report["trainees"][number];
export type Prediction = Report["predictions"][number];

/** Попытки занятия по стадиям — с одним знаменателем у каждой цифры. */
export interface AttemptCounts {
  assigned: number;
  appeared: number;
  closed: number;
  scored: number;
  partial: number;
  unscored: number;
}

export function attemptCounts(
  assigned: number,
  cards: Pick<Card, "state">[],
  evaluations: Evaluation[],
): AttemptCounts {
  const closed = cards.filter((card) => isClosed(card)).length;
  const scored = evaluations.filter((item) => hasScore(item)).length;
  return {
    assigned,
    appeared: cards.length,
    closed,
    scored,
    partial: evaluations.filter(
      (item) => hasScore(item) && item.status === "partial",
    ).length,
    unscored: Math.max(0, closed - scored),
  };
}

export interface WeakPoint {
  key: string;
  label: string;
  explanation: string;
  critical: boolean;
}

export interface TraineeLine {
  userId: string;
  fullName: string;
  seat: number;
  level: number;
  /** Балл из отчёта сервера; null — оценённых попыток нет, это не ноль. */
  total: number | null;
  scoredAttempts: number;
  reactionS: number | null;
  handlingS: number | null;
  /** Отклонение от норматива снимка занятия, с; плюс — дольше норматива. */
  reactionDeltaS: number | null;
  handlingDeltaS: number | null;
  errors: number | null;
  weak: WeakPoint[];
  /** Из аналитики сервера (C-06); отсутствуют, если аналитика недоступна. */
  reactionEstimated?: boolean;
  handlingEstimated?: boolean;
  reactionValues?: number[];
  handlingValues?: number[];
  errorsText?: string[];
  recommendation?: TraineeAnalytics["recommendation"];
  completedCount?: number;
}

/**
 * Строка на каждое место занятия. Слабые места — критерии с баллом ниже 1 из
 * вердиктов этого обучаемого, с объяснением оценщика; критические — первыми.
 */
export function traineeLines(
  session: Pick<Session, "participants" | "settings_snapshot">,
  report: Pick<Report, "trainees"> | null,
  evaluations: Evaluation[],
  fullName: (id: string) => string,
): TraineeLine[] {
  const norms = session.settings_snapshot;
  return session.participants.map((participant) => {
    const own = evaluations.filter(
      (item) => item.trainee_id === participant.user_id && hasScore(item),
    );
    const row = report?.trainees.find(
      (item) => item.user_id === participant.user_id,
    );
    const counted = own.length > 0 && row !== undefined;
    return {
      userId: participant.user_id,
      fullName: row?.full_name ?? fullName(participant.user_id),
      seat: participant.workstation_number,
      level: participant.level,
      total: counted ? row.total : null,
      scoredAttempts: own.length,
      reactionS: counted ? row.reaction_time_s : null,
      handlingS: counted ? row.handling_time_s : null,
      // Время без измерения сервер отдаёт null (не 0) — разницы с нормативом тогда нет.
      reactionDeltaS:
        counted && row.reaction_time_s !== null
          ? row.reaction_time_s - norms.reaction_normative_s
          : null,
      handlingDeltaS:
        counted && row.handling_time_s !== null
          ? row.handling_time_s - norms.handling_normative_s
          : null,
      errors: counted ? row.errors : null,
      weak: weakPoints(participant.user_id, evaluations),
    };
  });
}

/**
 * Слабые места — критерии с баллом ниже 1 из оценённых вердиктов обучаемого,
 * с объяснением оценщика; критические — первыми.
 */
export function weakPoints(
  userId: string,
  evaluations: Evaluation[],
): WeakPoint[] {
  const weak = new Map<string, WeakPoint>();
  for (const evaluation of evaluations)
    if (evaluation.trainee_id === userId && hasScore(evaluation))
      for (const criterion of evaluation.criteria)
        if (criterion.score < 1 && !weak.has(criterion.key))
          weak.set(criterion.key, {
            key: criterion.key,
            label: criterionLabel(criterion.key),
            explanation: readable(criterion.explanation),
            critical: criterion.critical,
          });
  return [...weak.values()].sort(
    (a, b) => Number(b.critical) - Number(a.critical),
  );
}

export interface TypicalError {
  key: string;
  label: string;
  /** Сколько оценённых попыток просели по критерию. */
  attempts: number;
  /** Из скольких оценённых попыток — один знаменатель для всей таблицы. */
  of: number;
  critical: number;
  example: string;
}

/** Типичные ошибки группы: частота просадки по критериям среди оценённых попыток. */
export function typicalErrors(evaluations: Evaluation[]): TypicalError[] {
  const scored = evaluations.filter((item) => hasScore(item));
  const byKey = new Map<string, TypicalError>();
  for (const evaluation of scored)
    for (const criterion of evaluation.criteria) {
      if (criterion.score >= 1) continue;
      const entry = byKey.get(criterion.key) ?? {
        key: criterion.key,
        label: criterionLabel(criterion.key),
        attempts: 0,
        of: scored.length,
        critical: 0,
        example: readable(criterion.explanation),
      };
      entry.attempts += 1;
      if (criterion.critical) entry.critical += 1;
      byKey.set(criterion.key, entry);
    }
  return [...byKey.values()].sort(
    (a, b) => b.attempts - a.attempts || b.critical - a.critical,
  );
}

export type Recommendation =
  | { kind: "cold"; basis: string }
  | { kind: "up" | "keep" | "down"; level: number; basis: string };

/**
 * Рекомендация следующей сложности — правило команды, раскрытое преподавателю:
 * меньше двух оценённых попыток — данных мало; все попытки от 80 % и без
 * критических ошибок — уровень выше; есть критическая ошибка или попытка ниже
 * 50 % — уровень ниже; иначе — тот же. Решение подтверждает преподаватель.
 */
export function recommend(
  level: number,
  evaluations: Evaluation[],
): Recommendation {
  const scored = evaluations.filter((item) => hasScore(item));
  if (scored.length < 2)
    return {
      kind: "cold",
      basis: `Оценённых попыток: ${scored.length}. Для рекомендации нужно хотя бы две.`,
    };
  const critical = scored.filter((item) =>
    item.criteria.some(
      (criterion) => criterion.critical && criterion.score < 1,
    ),
  ).length;
  const low = scored.filter((item) => item.total < 0.5).length;
  const high = scored.filter((item) => item.total >= 0.8).length;
  if (critical > 0 || low > 0)
    return {
      kind: level > 1 ? "down" : "keep",
      level: Math.max(1, level - 1),
      basis: [
        critical > 0 && `критические ошибки в ${critical} из ${scored.length}`,
        low > 0 && `ниже 50 % в ${low} из ${scored.length}`,
      ]
        .filter(Boolean)
        .join("; "),
    };
  if (high === scored.length)
    return {
      kind: level < 4 ? "up" : "keep",
      level: Math.min(4, level + 1),
      basis: `все ${scored.length} попытки от 80 %, критических ошибок нет`,
    };
  return {
    kind: "keep",
    level,
    basis: `от 80 % — ${high} из ${scored.length}, критических ошибок нет`,
  };
}

export interface ForecastLine {
  cardId: string;
  expectedScore: number;
  actualScore: number | null;
  expectedTimeS: number;
  actualTimeS: number | null;
}

/** Прогноз и факт одной попытки — рядом, в одних единицах. */
export function forecastLines(
  predictions: Prediction[],
  cardIds: Set<string>,
): ForecastLine[] {
  return predictions
    .filter((item) => cardIds.has(item.card_id))
    .map((item) => ({
      cardId: item.card_id,
      expectedScore: item.expected_score,
      actualScore: item.actual_score,
      expectedTimeS: item.expected_time_s,
      actualTimeS: item.actual_time_s,
    }));
}

/** Секунды — «0:42», «3:05»; дробные округляются до целых. */
export function formatSeconds(seconds: number): string {
  const whole = Math.round(Math.abs(seconds));
  return `${seconds < 0 ? "−" : ""}${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * Строки по местам из аналитики сервера: балл — среднее эффективной оценки,
 * время — среднее по достоверным измерениям или оценочное значение попытки,
 * ошибки — по категориям сервера. Слабые критерии — из вердиктов, как раньше.
 */
export function linesFromAnalytics(
  session: Pick<Session, "participants">,
  analytics: SessionAnalytics,
  evaluations: Evaluation[],
  fullName: (id: string) => string,
  normatives: { reaction: number; handling: number },
  ownerOf?: (attempt: SessionAnalytics["attempts"][number]) => string,
): TraineeLine[] {
  return session.participants.map((participant) => {
    const trainee = analytics.trainees.find(
      (item) => item.user_id === participant.user_id,
    );
    const reaction = trainee
      ? traineeTime(trainee, analytics.attempts, "reaction", ownerOf)
      : null;
    const handling = trainee
      ? traineeTime(trainee, analytics.attempts, "handling", ownerOf)
      : null;
    return {
      userId: participant.user_id,
      fullName: fullName(participant.user_id),
      seat: participant.workstation_number,
      level: trainee?.current_level ?? participant.level,
      total: trainee?.mean_effective_score ?? null,
      scoredAttempts: trainee?.evaluated_count ?? 0,
      reactionS: reaction?.seconds ?? null,
      handlingS: handling?.seconds ?? null,
      reactionDeltaS:
        reaction?.seconds == null
          ? null
          : reaction.seconds - normatives.reaction,
      handlingDeltaS:
        handling?.seconds == null
          ? null
          : handling.seconds - normatives.handling,
      errors: null,
      weak: weakPoints(participant.user_id, evaluations),
      reactionEstimated: reaction?.estimated,
      handlingEstimated: handling?.estimated,
      reactionValues: reaction?.values,
      handlingValues: handling?.values,
      errorsText: trainee ? errorSummary(trainee.errors) : undefined,
      recommendation: trainee?.recommendation ?? null,
      completedCount: trainee?.completed_count,
    };
  });
}

export interface Share {
  ok: number;
  total: number;
}

export interface NormShares {
  reaction: Share;
  handling: Share;
  passed: Share;
}

/**
 * Нормы как доля карточек (так их формулируют NFPA 1225 / NENA: «90 % вызовов за 60 с»):
 * сколько оценённых карточек уложились в норматив реакции и отработки и сколько
 * зачтено (без критической ошибки и от 70 %). Карточка без критерия в знаменатель не идёт.
 */
export function normShares(
  evaluations: readonly Evaluation[],
  /** Новый балл преподавателя по карточке («не согласен»): он главнее флага ошибки. */
  teacherTotals: ReadonlyMap<string, number> = new Map(),
): NormShares {
  const scored = evaluations.filter((item) => hasScore(item));
  const share = (key: string): Share => {
    const measured = scored
      .map((item) => item.criteria.find((criterion) => criterion.key === key))
      .filter((criterion) => criterion !== undefined);
    return {
      ok: measured.filter((criterion) => criterion.score >= 1).length,
      total: measured.length,
    };
  };
  return {
    reaction: share("reaction_time"),
    handling: share("handling_time"),
    passed: {
      ok: scored.filter(
        (item) =>
          attemptVerdict(
            item.total,
            item.criteria,
            teacherTotals.get(item.card_id) ?? null,
          ).passed,
      ).length,
      total: scored.length,
    },
  };
}

export function formatShare({ ok, total }: Share): string {
  return total === 0 ? "—" : `${Math.round((ok / total) * 100)} %`;
}
