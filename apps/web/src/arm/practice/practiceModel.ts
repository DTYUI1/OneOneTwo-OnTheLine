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
