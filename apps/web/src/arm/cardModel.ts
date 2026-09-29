// Чистая модель АРМ: подписи, допустимые переходы и таймеры нормативов.
// Без React и сети — чтобы покрывать vitest и переиспользовать в пульте (T-015).
import type { Card } from "../shared/api";
import type { components } from "../api-client/schema";

// shared/api.ts принадлежит капитану, поэтому недостающие типы берём прямо из схемы.
export type Service = components["schemas"]["Service"];
export type Settings = components["schemas"]["Settings"];

export type CardState = Card["state"];
/** Статусы, которые ставит диспетчер ДДС (подмножество state из контракта). */
export type DispatcherStatus =
  | "accepted"
  | "rejected"
  | "responding"
  | "arrived"
  | "working"
  | "refused"
  | "completed";

/** Подписи со скриншотов arm_dds/09–20 и нижней панели служб (06). */
export const STATE_LABELS: Record<CardState, string> = {
  added: "Добавлена",
  received: "Получена службой",
  accepted: "Принята",
  rejected: "Не принята",
  responding: "Начало реагирования",
  // Памятка ДДС, стр. 22; выбор этих этапов в АРМ подключает D-03 (дополнение C-01 24.09).
  arrived: "Прибытие",
  working: "Проведение работ",
  refused: "Отказ от выполнения работ",
  completed: "Работы завершены",
  redirected: "Перенаправлена",
};

const FLOW: Record<CardState, DispatcherStatus[]> = {
  // Автомат I-TIME v3 / evalcore.defaults.CARD_TRANSITIONS (памятка ДДС, стр. 22–25, 32):
  // сначала «Принята / Не принята»; после «Не принята» можно поставить «Принята»;
  // этапы реагирования идут только вперёд, пропуск допустим — обязательные этапы задаёт
  // эталон сценария; завершить или отказаться можно на любом этапе после принятия.
  added: ["accepted", "rejected"],
  received: ["accepted", "rejected"],
  rejected: ["accepted"],
  accepted: ["responding", "arrived", "working", "completed", "refused"],
  responding: ["arrived", "working", "completed", "refused"],
  arrived: ["working", "completed", "refused"],
  working: ["completed", "refused"],
  refused: [],
  completed: [],
  redirected: [],
};

/** Отказные статусы требуют причины в комментарии — сервер отвечает 422 reason_required. */
export const REASON_REQUIRED: ReadonlySet<DispatcherStatus> = new Set([
  "rejected",
  "refused",
]);

/** После этих статусов карточка закрывается для правок (памятка, стр. 22). */
export function closesCard(status: DispatcherStatus): boolean {
  return status === "completed" || status === "refused";
}

/**
 * Что писать в комментарии к статусу — по памятке ДДС (стр. 21–26, 32). Подсказка
 * про интерфейс, а не про ответ задания: эталон обучаемому не раскрывается.
 */
export const STATUS_COMMENT_HINTS: Record<DispatcherStatus, string> = {
  accepted: "что принято к исполнению, кому поручено",
  rejected: "причина: почему не принята и кому передана информация",
  responding: "кто выехал и куда",
  arrived: "прибытие на место: что обнаружено",
  working: "ход работ по полученным сведениям",
  completed: "результаты работ — после сохранения карточка закроется",
  refused: "причина отказа и результаты действий",
};

/** Что диспетчер может выбрать в выпадающем списке при текущем состоянии. */
export function availableStatuses(state: CardState): DispatcherStatus[] {
  return FLOW[state];
}

/** Перенаправить можно только после отказа принять карточку (rejected → redirected). */
export function canRedirect(state: CardState): boolean {
  return state === "rejected";
}

/** Карточка закрыта — действий больше нет, таймер отработки останавливается. */
export function isClosed(card: Pick<Card, "state">): boolean {
  return ["completed", "refused", "redirected"].includes(card.state);
}

/**
 * Порядок реестра (замечание капитана 28.09): новые происшествия сверху, старые снизу.
 * Сервер отдаёт карточки по появлению; при равном времени — обратный порядок id.
 */
export function newestFirst<T extends Pick<Card, "id" | "appeared_at">>(
  cards: readonly T[],
): T[] {
  return [...cards].sort(
    (a, b) =>
      Date.parse(b.appeared_at) - Date.parse(a.appeared_at) ||
      b.id.localeCompare(a.id),
  );
}

/** «Россия, Москва, (САО, Учебный)» + улица и дом — как в шапке карточки (06). */
export function formatAddress(address: Card["source"]["address"]): string {
  const house = [address.house, address.building].filter(Boolean).join(" к");
  const street = [address.street, house].filter(Boolean).join(", ");
  const apartment = address.apartment ? `кв. ${address.apartment}` : "";
  return [street, apartment].filter(Boolean).join(", ");
}

export function formatOkrug(address: Card["source"]["address"]): string {
  const parts = [address.okrug, address.district].filter(Boolean);
  return parts.length ? `${address.city}, (${parts.join(", ")})` : address.city;
}

export interface TimerView {
  /** Целые секунды с момента отсчёта. */
  seconds: number;
  /** Норматив превышен — поле красное (Q&A Q10, Q11). */
  overdue: boolean;
  /** Отсчёт остановлен: реакция состоялась или карточка закрыта. */
  stopped: boolean;
}

export function elapsedSeconds(from: string, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(from)) / 1000));
}

/** «Сейчас» для незавершённой попытки, но не позже её прерывания (завершение занятия). */
function stopAt(card: Card, now: number): number {
  return card.interrupted_at
    ? Math.min(now, Date.parse(card.interrupted_at))
    : now;
}

/**
 * Таймер реакции: от появления строки на АРМ обучаемого (delivered_at) до открытия.
 * Норматив по умолчанию 30 с, приходит из /settings. Пока строку не показали,
 * отсчёта нет — как в общем расчёте C-02 (timingAdapter).
 */
export function reactionTimer(
  card: Card,
  normativeSeconds: number,
  now: number,
): TimerView {
  if (!card.delivered_at) return { seconds: 0, overdue: false, stopped: true };
  const until = card.opened_at ? Date.parse(card.opened_at) : stopAt(card, now);
  const seconds = elapsedSeconds(card.delivered_at, until);
  return {
    seconds,
    overdue: seconds > normativeSeconds,
    stopped: card.opened_at !== null || card.interrupted_at !== null,
  };
}

/**
 * Таймер отработки карточки: от открытия до закрытия. Норматив 3 минуты.
 * Пока карточка не открыта — отсчёт не начат.
 */
export function handlingTimer(
  card: Card,
  normativeSeconds: number,
  now: number,
): TimerView {
  if (!card.opened_at) return { seconds: 0, overdue: false, stopped: true };
  const until = card.closed_at ? Date.parse(card.closed_at) : stopAt(card, now);
  const seconds = elapsedSeconds(card.opened_at, until);
  return {
    seconds,
    overdue: seconds > normativeSeconds,
    stopped: card.closed_at !== null || card.interrupted_at !== null,
  };
}

/**
 * мм:сс — формат таймера в правом верхнем углу карточки (card_112/04–09).
 * Свыше 99:59 показываем «99:59+»: столько минут норматив уже не измеряет,
 * а длинное число ломает вёрстку строки (в моке карточки датированы прошлыми днями).
 */
export function formatDuration(seconds: number): string {
  if (seconds > 5999) return "99:59+";
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Клавиши в форме статуса и перенаправления: Enter в поле ввода отправляет форму
 * (статус ставится 4–6 раз за вызов), Shift+Enter — нет; Esc закрывает форму,
 * не выбрасывая обучаемого из карточки. Enter на списке и кнопках остаётся штатным.
 */
export function statusFormKey(
  key: string,
  shift: boolean,
  targetIsInput: boolean,
): "submit" | "cancel" | null {
  if (key === "Escape") return "cancel";
  if (key === "Enter" && !shift && targetIsInput) return "submit";
  return null;
}

/**
 * Комментарий при смене статуса в форме. Прошлый комментарий карточки очищается,
 * чтобы открылась подсказка под новый статус и чужой текст не ушёл по ошибке;
 * черновик этой пары карточка+статус возвращается; введённое вручную не трогаем.
 */
export function commentOnStatusChange(
  current: string,
  cardComment: string,
  draft: string | undefined,
): string {
  if (draft !== undefined) return draft;
  // В карточку уходит comment.trim(), а в поле остаётся исходный текст.
  return current.trim() === cardComment.trim() ? "" : current;
}

/**
 * Какая норма горит на таймере шапки: до «Принята / Не принята» — реакция
 * (I-TIME v3, как на вкладке), после — обработка карточки.
 */
export function timerLabel(state: CardState): "реакция" | "обработка" {
  return state === "added" || state === "received" ? "реакция" : "обработка";
}

/** Ключевые записи истории — как на arm_dds/12: статусы с комментариями и правки полей. */
const KEY_HISTORY: ReadonlySet<string> = new Set([
  "status_change",
  "redirect",
  "field_change",
]);

/** История по умолчанию — только ключевые записи; служебные — по кнопке «все действия». */
export function visibleHistory<T extends { type: string }>(
  events: readonly T[],
  all: boolean,
): T[] {
  return all
    ? [...events]
    : events.filter((event) => KEY_HISTORY.has(event.type));
}
