// Обучение по интерфейсу с наставником (просьба капитана 18.10): при первом входе на список
// происшествий Николай Сергеевич предлагает пройти экран по порядку, а потом показывает каждую
// часть и кнопку — рамкой и рукой — и говорит про неё одну-две фразы. Повторить — из справки
// «?», кнопкой «Пройти с наставником». Здесь нет React: шаги, поиск их элементов на экране,
// память «уже предлагали» и запрос повтора. Вид — InterfaceTour.tsx.
//
// Части экрана — те же `data-help`, что у «Объяснения экрана» (arm/help/topics.ts), кнопки
// шапки — по их подписи. Тексты и записи шагов — реплики наставника (shared/mascot/voice).

export interface TourStep {
  /** Реплика наставника: id в voice/lines.json. */
  readonly line: string;
  /** Что показать: часть с data-help, кнопка с подписью или кнопка «?». */
  readonly target:
    | { readonly help: string }
    | { readonly button: string }
    | { readonly trigger: true };
}

/** Предложение пройти обучение — первое окно. */
export const OFFER_LINE = "tour-offer";

/** Порядок — как смотрят на экран: сверху вниз, слева направо; последним — «?». */
export const TOUR_STEPS: readonly TourStep[] = [
  { line: "tour-tabs", target: { help: "arm-tabs" } },
  { line: "tour-search", target: { help: "arm-search" } },
  { line: "tour-clock", target: { help: "arm-clock" } },
  { line: "tour-list", target: { help: "arm-list" } },
  { line: "tour-columns", target: { help: "arm-columns" } },
  { line: "tour-row", target: { help: "arm-row" } },
  { line: "tour-preview", target: { help: "arm-preview" } },
  { line: "tour-practice", target: { help: "tool-practice" } },
  { line: "tour-stages", target: { help: "trainer-stages" } },
  { line: "tour-path", target: { help: "tool-path" } },
  { line: "tour-catalog", target: { help: "tool-catalog" } },
  { line: "tour-warmup", target: { help: "tool-warmup" } },
  { line: "tour-results", target: { help: "tool-results" } },
  { line: "tour-reference", target: { help: "tool-reference" } },
  { line: "tour-workflow", target: { button: "Порядок работы" } },
  { line: "tour-report", target: { button: "Сообщить об ошибке" } },
  { line: "tour-end", target: { trigger: true } },
];

const visible = (el: Element | null): el is HTMLElement =>
  el instanceof HTMLElement && el.isConnected && el.getClientRects().length > 0;

/** Элемент шага на экране; null — части сейчас нет (пустой список, не та ступень). */
export function findTarget(
  root: ParentNode,
  target: TourStep["target"],
): HTMLElement | null {
  if ("help" in target) {
    // Строк и стрелок предпросмотра много — показываем первую видимую.
    for (const el of root.querySelectorAll(`[data-help="${target.help}"]`))
      if (visible(el)) return el;
    return null;
  }
  if ("button" in target) {
    for (const el of root.querySelectorAll("button"))
      if (el.textContent?.trim() === target.button && visible(el)) return el;
    return null;
  }
  const trigger = root.querySelector("[data-help-trigger]");
  return visible(trigger) ? trigger : null;
}

/** Шаги, чьи части сейчас на экране: обучение идёт только по тому, что видно. */
export function visibleSteps(root: ParentNode): TourStep[] {
  return TOUR_STEPS.filter((step) => findTarget(root, step.target) !== null);
}

// ---------------------------------------------------------------- «уже предлагали»
// Компьютеры в классе общие, поэтому память — по пользователю. Хранилище недоступно —
// предложение живёт до перезагрузки страницы.

const memory = new Set<string>();
const offeredKey = (userId: string) => `arm112:mascot-tour:${userId}`;

export function tourOffered(userId: string): boolean {
  try {
    return localStorage.getItem(offeredKey(userId)) === "1";
  } catch {
    return memory.has(userId);
  }
}

export function markTourOffered(userId: string): void {
  memory.add(userId);
  try {
    localStorage.setItem(offeredKey(userId), "1");
  } catch {
    // Не сохранилось — не предложим до перезагрузки страницы.
  }
}

// ---------------------------------------------------------------- повтор из справки «?»

let requests = 0;
const listeners = new Set<() => void>();

/** «Пройти с наставником» в справке: начать обучение заново. */
export function requestTour(): void {
  requests += 1;
  for (const listener of listeners) listener();
}

/** Сколько раз просили начать — экран начинает, когда число выросло. */
export function tourRequests(): number {
  return requests;
}

export function subscribeTour(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
