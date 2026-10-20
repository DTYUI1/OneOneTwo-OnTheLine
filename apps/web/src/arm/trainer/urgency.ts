// Срочность таймера норматива в подсказке «Вместе» (TC-06, touches.md «Таймеры и срочность»):
// три стадии и по одному сигналу на карточку. Здесь нет React и звука — только расчёт, его
// проверяет urgency.test.ts. Вид АРМ обучаемого (памятка ДДС) не меняется: стадия — это
// цвет строки «Принята» ждёт в подсказке «Вместе», сам таймер считает общий расчёт C-02.

/** Жёлтая стадия начинается с 70 % норматива (touches.md: «70–100 % — скоро норматив»). */
export const SOON_PERCENT = 70;
/** Двойной бип — за столько секунд до конца норматива («осталось 10 с»). */
export const WARN_BEFORE_S = 10;
/**
 * Опоздание, с которым сигнал ещё имеет смысл: вкладка в фоне тикает редко, а сигнал
 * «осталось 10 с» через минуту после порога уже врёт; открытая позже карточка не пищит.
 */
export const LATE_SIGNAL_S = 5;

/**
 * Наставник напоминает о нормативе («30 секунд — строгая норма диспетчера ДДС», просьба
 * капитана 18.10) за столько секунд до конца: его реплика (около 7 с) заканчивается раньше
 * двойного бипа «осталось 10 с», голоса не накладываются. При нормативе 30 с — с 12-й секунды.
 */
export const REMIND_BEFORE_S = WARN_BEFORE_S + 8;

/** Пора напомнить о нормативе — и дальше, пока «Принята» ждёт (в том числе сверх него). */
export function remindDue(seconds: number, normative: number): boolean {
  return seconds >= Math.max(0, normative - REMIND_BEFORE_S);
}

/** Слова наставника о нормативе — для экрана; голос находит запись по этому тексту. */
export function normText(normative: number): string {
  const tens = normative % 100;
  const ones = normative % 10;
  const unit =
    tens >= 11 && tens <= 14
      ? "секунд"
      : ones === 1
        ? "секунда"
        : ones >= 2 && ones <= 4
          ? "секунды"
          : "секунд";
  return `Обратите внимание: на «Принята» — ${normative} ${unit}. Это строгая норма диспетчера ДДС.`;
}

export type Urgency = "calm" | "soon" | "over";
export type UrgencySignal = "warn" | "over";

/**
 * Стадия по целым секундам ожидания: до 70 % — спокойно (как было), 70–100 % включительно —
 * «скоро норматив», дальше — «сверх норматива». `over` — решение общего расчёта C-02
 * (reaction_overdue): оно главнее, если сервер уже считает норматив нарушенным.
 */
export function urgencyStage(
  seconds: number,
  normative: number,
  over = false,
): Urgency {
  if (over || seconds > normative) return "over";
  // Целая арифметика: 0,7 × 30 в плавающей точке не даёт ровно 21.
  return seconds * 100 >= normative * SOON_PERCENT ? "soon" : "calm";
}

const LABELS: Record<Urgency, string | null> = {
  calm: null,
  soon: "скоро норматив",
  over: "сверх норматива",
};

/** Подпись стадии для таймера: «0:24 · скоро норматив»; в спокойной стадии — только время. */
export function urgencyText(clock: string, stage: Urgency): string {
  const label = LABELS[stage];
  return label ? `${clock} · ${label}` : clock;
}

/**
 * Какой сигнал пора подать. «warn» — за 10 с до конца, «over» — норматив прошёл. Каждый
 * сигнал подаётся один раз на карточку (`given`) и только в первые секунды после порога.
 */
export function dueSignal(
  seconds: number,
  normative: number,
  given: ReadonlySet<UrgencySignal>,
): UrgencySignal | null {
  if (seconds > normative)
    return !given.has("over") && seconds - normative <= LATE_SIGNAL_S
      ? "over"
      : null;
  const from = Math.max(0, normative - WARN_BEFORE_S);
  return !given.has("warn") &&
    seconds >= from &&
    seconds - from <= LATE_SIGNAL_S
    ? "warn"
    : null;
}

const givenByCard = new Map<string, Set<UrgencySignal>>();

/**
 * Занять сигнал для карточки: вернёт, что подать сейчас, и запомнит это — повторный вызов
 * (перерисовка, вторая вкладка зоны, «без звука») тот же сигнал уже не отдаст. Память живёт
 * до перезагрузки страницы: этого хватает, норматив — 30 с.
 */
export function claimSignal(
  cardId: string,
  seconds: number,
  normative: number,
): UrgencySignal | null {
  const given = givenByCard.get(cardId) ?? new Set<UrgencySignal>();
  const signal = dueSignal(seconds, normative, given);
  if (!signal) return null;
  given.add(signal);
  // «Просрочено» после «осталось 10 с» — разные сигналы; пропущенный «warn» уже не нужен.
  if (signal === "over") given.add("warn");
  givenByCard.set(cardId, given);
  return signal;
}

/** Забыть, кому что подано (для тестов). */
export function resetSignals(): void {
  givenByCard.clear();
}
