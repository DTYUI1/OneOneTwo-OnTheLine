// Запуск тренировки (29.09): когда спрашивать о прерывании и какую карточку открыть.
// Сессия тренировки на сервере остаётся running и после закрытия карточки, поэтому
// «идёт» считается по карточке, а не по сессии.
import type { components } from "../../api-client/schema";

type Card = components["schemas"]["Card"];

/** Идёт ли тренировка: есть открытая, не закрытая и не прерванная карточка тренировки. */
export function practiceRunning(
  cards: readonly Card[],
  practiceSessionIds: ReadonlySet<string>,
): boolean {
  return cards.some(
    (card) =>
      practiceSessionIds.has(card.session_id) &&
      !card.closed_at &&
      !card.interrupted_at,
  );
}

/** Карточка только что запущенной тренировки, если она уже пришла. */
export function pickPracticeCard(
  cards: readonly Card[],
  sessionId: string,
): Card | undefined {
  return cards.find((card) => card.session_id === sessionId);
}

/** Запуск тренировки: ступень, сценарий каталога, повтор карточки и режим этапа. */
export interface PracticeQueryInput {
  readonly step?: number;
  readonly scenario?: string;
  readonly again?: string;
  readonly mode?: "watch" | "together" | "solo" | "expert";
}

/**
 * Параметры POST /practice. Сценарий каталога — без ступени и повтора. Показ курсором
 * («Смотрю», «Как сделал бы опытный») идёт с `demo` — видом показа: сервер не засчитывает
 * его карточку ни в ступени, ни в «Мои результаты» (HQ-034) и даёт перехватить только
 * «Смотрю» (HQ-035).
 */
export function practiceQuery({
  step,
  scenario,
  again,
  mode,
}: PracticeQueryInput): {
  step?: number;
  scenario?: string;
  scenario_id?: string;
  again?: string;
  demo?: "watch" | "expert";
} {
  return {
    ...(scenario && step && !again
      ? { step, scenario_id: scenario }
      : scenario
        ? { scenario }
        : { ...(step ? { step } : {}), ...(again ? { again } : {}) }),
    ...(mode === "watch" || mode === "expert" ? { demo: mode } : {}),
  };
}

/**
 * Перехват показа «Беру управление» (HQ-035, лист решений 18.10): у какой тренировки
 * снять признак показа (POST /practice/{id}/take-over), чтобы карточка, которую дальше
 * ведёт обучаемый, пошла в ступень 1 как попытка «Вместе». Показ опытного не
 * перехватывают; нет показа или карточки — null.
 */
export function takeOverSession(
  demo: { readonly expert: boolean } | null,
  card: { readonly sessionId: string } | null,
): string | null {
  if (!demo || demo.expert || !card) return null;
  return card.sessionId;
}
