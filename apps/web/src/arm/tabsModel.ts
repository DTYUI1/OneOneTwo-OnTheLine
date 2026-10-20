// Вкладки происшествий (27.09, параллельная работа): чистая логика без React и сети.
// Реальный АРМ держит каждое происшествие в своей вкладке браузера (arm_dds/04, 07);
// здесь вкладки внутри приложения, и строка состояния видна поверх любой карточки.
import type { Card } from "../shared/api";
import { formatHandlingNormative } from "../shared/handlingNormative";
import { formatDuration, isClosed } from "./cardModel";
import type { LiveTiming } from "./timingAdapter";
import { urgencyStage, type Urgency } from "./trainer/urgency";

/** Происшествия в работе: идущее занятие, карточка не закрыта и не прервана; по появлению. */
export function workingCards(
  cards: readonly Card[],
  runningSessionIds: ReadonlySet<string>,
): Card[] {
  return cards
    .filter(
      (card) =>
        runningSessionIds.has(card.session_id) &&
        !isClosed(card) &&
        card.interrupted_at === null,
    )
    .sort(
      (a, b) =>
        Date.parse(a.appeared_at) - Date.parse(b.appeared_at) ||
        a.id.localeCompare(b.id),
    );
}

export interface TabClock {
  label: "реакция" | "обработка";
  seconds: number;
  overdue: boolean;
}

/**
 * Активная обработка v3: полная минус подтверждённое ожидание бригады (I-TIME v3 п.5–6).
 * Пока бригада едет или работает, счёт диспетчера стоит, — иначе таймер первой карточки
 * краснел бы, пока он честно ждёт доклада и работает со второй.
 */
export function activeHandling(
  timing: LiveTiming,
  waitingS: number | null,
): { seconds: number; overdue: boolean } | null {
  const full = timing.handling.seconds;
  if (full === null) return null;
  if (timing.version !== 3 || waitingS === null)
    return { seconds: full, overdue: timing.handling.over };
  const seconds = Math.max(0, full - waitingS);
  return { seconds, overdue: seconds > timing.handling.normative };
}

/**
 * Идущий отсчёт на вкладке — по полям самой карточки, без её истории: вкладок в работе
 * несколько, и АРМ не грузит журналы карточек, которые обучаемый сейчас не смотрит
 * (qa/e2e/captain-history). Правила — I-TIME v3: реакция идёт с показа строки
 * (delivered_at), пока не поставлено «Принята / Не принята»; обработка — с открытия
 * до завершения, без подтверждённого ожидания бригады. Точные итоги — в карточке и разборе.
 */
export function tabClock(
  card: Pick<Card, "state" | "delivered_at" | "opened_at" | "interrupted_at">,
  now: number,
  waitingS: number | null,
  normatives: { reaction: number; handling: number },
): TabClock | null {
  const stop = card.interrupted_at
    ? Math.min(now, Date.parse(card.interrupted_at))
    : now;
  if (card.state === "added" || card.state === "received") {
    if (!card.delivered_at) return null;
    const seconds = Math.max(
      0,
      Math.floor((stop - Date.parse(card.delivered_at)) / 1000),
    );
    return {
      label: "реакция",
      seconds,
      overdue: seconds > normatives.reaction,
    };
  }
  // Окончательная «Не принята» — терминал обработки: отсчёта нет.
  if (card.state === "rejected" || !card.opened_at) return null;
  const full = (stop - Date.parse(card.opened_at)) / 1000;
  const seconds = Math.max(0, Math.floor(full - (waitingS ?? 0)));
  return {
    label: "обработка",
    seconds,
    overdue: seconds > normatives.handling,
  };
}

export interface WorkBadge {
  /** «01:42» — активная обработка, как в оценке. */
  readonly text: string;
  /** Стадии — как у «Принята» ждёт (urgency.ts): до 70 % спокойно, затем жёлтый и красный. */
  readonly stage: Urgency;
  /** Подсказка при наведении: «Отработка 01:42 из 3:00. …». */
  readonly title: string;
}

/**
 * Таймер отработки на вкладке происшествия (капитан, 19.10): сколько идёт работа с
 * карточкой. Только обработка — реакцию на «Принята» считает подсказка тренажёра; до
 * открытия и после окончательной «Не принята» таймера нет.
 */
export function workBadge(
  clock: TabClock | null,
  handlingNormativeS: number,
): WorkBadge | null {
  if (!clock || clock.label !== "обработка") return null;
  const text = formatDuration(clock.seconds);
  return {
    text,
    stage: urgencyStage(clock.seconds, handlingNormativeS),
    title: `Отработка ${text} из ${formatHandlingNormative(handlingNormativeS)}. Ожидание доклада бригады не считается.`,
  };
}
