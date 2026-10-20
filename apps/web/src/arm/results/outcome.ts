// «Что было дальше» (DT-08): после закрытой карточки тренировки — короткий исход, что
// стало с людьми и как на это повлияли время и решения обучаемого. Диспетчеры почти не
// узнают исход вызова (опрос BMC Emergency Medicine, 2025: 77,7 % — ни разу за месяц);
// исход показывает, ради чего спешить.
//
// Исход задаётся в сценарии. Сценарии ДДС (data/scenarios, GP-27): блок `outcome` файла
// сценария, его отдаёт API вместе с разбором (CardTraining.outcome) — это исход ЭТОГО сценария.
// Старые сценарии без блока: data/practice/*.json, блок `outcome`, по номеру карточки. Образ web
// собирается без data/, поэтому здесь — копия (outcomes.json), её собирает и сверяет
// outcome.test.ts (UPDATE_PRACTICE_OUTCOMES=1 pnpm test). Нет исхода — блок не показывается.

import raw from "./outcomes.json";

export interface ScenarioOutcome {
  /** Полный ход (уровень 1): что стало с людьми, когда службы отработали вовремя. */
  readonly people: string;
  /** Чем обернулась задержка: «Принята» позже норматива. */
  readonly late: string;
  /** Почему это важно — только с источником; нет — строка не показывается. */
  readonly why?: string;
  /** Осложнение (уровень 2): что было на самом деле, когда работы не понадобились. */
  readonly complication: string;
}

/** Исход, который отдаёт API (CardTraining.outcome): блок `outcome` файла сценария. */
export interface CardOutcome {
  readonly people: string;
  readonly late: string;
  readonly why?: string;
  /** Что значит ход статусов не по эталону в этом сценарии; нет — общая строка. */
  readonly status?: string;
}

export interface PracticeIncident {
  readonly order: number;
  readonly key: string;
  readonly title: string;
  readonly outcome?: ScenarioOutcome;
}

/** Копия для бандла: исход по номеру происшествия сценария (`order`). */
export type OutcomeCopy = Record<
  string,
  { key: string; outcome: ScenarioOutcome }
>;

export function compactOutcomes(
  incidents: readonly PracticeIncident[],
): OutcomeCopy {
  const copy: OutcomeCopy = {};
  for (const incident of [...incidents].sort((a, b) => a.order - b.order))
    if (incident.outcome)
      copy[String(incident.order)] = {
        key: incident.key,
        outcome: incident.outcome,
      };
  return copy;
}

/**
 * Карточка тренировки: номер 70005{происшествие}{служба}{уровень} — так его строит
 * apps/api/app/seed/practice.py (card_number). Уровень 1 — полный ход, 2 — осложнение.
 */
export function practiceCard(
  number: string,
): { readonly order: string; readonly level: 1 | 2 } | null {
  const match = /^70005(\d)(\d)([12])$/.exec(number);
  return match ? { order: match[1], level: match[3] === "1" ? 1 : 2 } : null;
}

const STATUS_FULL =
  "Статусы в карточке шли не по докладам бригады — руководитель и следующие службы видели не то, что было на месте.";
const STATUS_COMPLICATION =
  "Работы на месте не проводились — такую карточку закрывают «Отказом от выполнения работ» с причиной, у скорой — «Работы завершены». В вашей карточке итог записан иначе.";
const LATE_COMPLICATION =
  "Карточку приняли позже норматива. Сегодня обошлось, но в другой раз на месте может быть человек, которому нужна помощь сейчас.";

export interface OutcomeInput {
  /** Номер происшествия карточки (card.source.number). */
  readonly number: string;
  /** «Принята» / «Не принята» позже норматива реакции. */
  readonly late: boolean;
  /** Ход статусов совпал с эталоном. */
  readonly statusOk: boolean;
  /** Исход сценария карточки от API; есть — берётся он, а не копия по номеру. */
  readonly scenario?: CardOutcome | null;
}

export interface Outcome {
  readonly paragraphs: readonly string[];
  readonly why: string | null;
}

/** Исход попытки; null — у сценария нет исхода (и это не карточка тренировки data/practice). */
export function pickOutcome(
  input: OutcomeInput,
  copy: OutcomeCopy = raw as OutcomeCopy,
): Outcome | null {
  // Свой исход сценария (GP-27) — один на ход карточки: полный ход и осложнения номером не делятся.
  if (input.scenario)
    return {
      paragraphs: [
        input.scenario.people,
        ...(input.late ? [input.scenario.late] : []),
        ...(input.statusOk ? [] : [input.scenario.status ?? STATUS_FULL]),
      ],
      why: input.scenario.why ?? null,
    };
  const card = practiceCard(input.number);
  const outcome = card ? copy[card.order]?.outcome : undefined;
  if (!card || !outcome) return null;
  if (card.level === 1)
    return {
      paragraphs: [
        outcome.people,
        ...(input.late ? [outcome.late] : []),
        ...(input.statusOk ? [] : [STATUS_FULL]),
      ],
      why: outcome.why ?? null,
    };
  return {
    paragraphs: [
      outcome.complication,
      ...(input.late ? [LATE_COMPLICATION] : []),
      ...(input.statusOk ? [] : [STATUS_COMPLICATION]),
    ],
    why: null,
  };
}

interface ScoredCriterion {
  readonly key: string;
  readonly score: number | null;
}

/** Факты для исхода из оценки: реакция в нормативе и ход статусов. */
export function outcomeFacts(criteria: readonly ScoredCriterion[]): {
  readonly late: boolean;
  readonly statusOk: boolean;
} {
  const score = (key: string) =>
    criteria.find((criterion) => criterion.key === key)?.score ?? null;
  const reaction = score("reaction_time");
  const flow = score("status_flow");
  return {
    late: reaction !== null && reaction < 1,
    statusOk: flow === null || flow >= 1,
  };
}
