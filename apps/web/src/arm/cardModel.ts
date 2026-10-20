// Чистая модель АРМ: подписи, допустимые переходы и таймеры нормативов.
// Без React и сети — чтобы покрывать vitest и переиспользовать в пульте (T-015).
import type { Card } from "../shared/api";
import type { components } from "../api-client/schema";
import { otherServiceStatus } from "./otherServices";

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
 * Необратимый статус сохраняется вторым нажатием ✓ (или Enter): первое только взводит
 * проверку. Подпись у ✓, пока проверка взведена, — во всех режимах: это поведение кнопки,
 * а не подсказка тренажёра (просьба 17.10: «неинтуитивно, что надо дабл-клик»).
 */
export function confirmAgainText(status: DispatcherStatus): string {
  return closesCard(status)
    ? "Нажмите ✓ или Enter ещё раз — карточка закроется"
    : `Нажмите ✓ или Enter ещё раз — статус «${STATE_LABELS[status]}» сохранится`;
}

/**
 * Что писать в комментарии к статусу — по памятке ДДС (стр. 21–26, 32). Подсказка
 * про интерфейс, а не про ответ задания: эталон обучаемому не раскрывается.
 */
export const STATUS_COMMENT_HINTS: Record<DispatcherStatus, string> = {
  // Ключевые сведения комментария (evalcore/comment.py): что случилось, пострадавшие,
  // решение. Их ищут во всех комментариях карточки, первый — при «Принята».
  accepted: "что случилось, есть ли пострадавшие, кого направили",
  rejected: "причина: почему не принята и кому передана информация",
  responding: "кто выехал и куда",
  arrived: "прибытие на место: что обнаружено",
  working: "ход работ по полученным сведениям",
  completed: "результаты работ — после сохранения карточка закроется",
  refused: "причина отказа и результаты действий",
};

/**
 * Службы без «Не принята» и «Отказ от выполнения работ» (памятка ДДС, с. 23): служба 103
 * вместо них ставит «Работы завершены» с комментарием «Завершение работ без бригады».
 * Тот же список — у оценщика (evalcore NO_REFUSAL_SERVICES).
 */
export const NO_REFUSAL_SERVICES: ReadonlySet<string> = new Set(["103"]);

/**
 * Что диспетчер может выбрать в выпадающем списке «Карандаша» при текущем состоянии
 * (памятка ДДС, с. 25) — с учётом своей службы (с. 23).
 */
export function availableStatuses(
  state: CardState,
  serviceId: string | null = null,
): DispatcherStatus[] {
  const flow = FLOW[state];
  return serviceId && NO_REFUSAL_SERVICES.has(serviceId)
    ? flow.filter((status) => !REASON_REQUIRED.has(status))
    : flow;
}

/** Подсказка в пустом поле «Комментарий» — с учётом своей службы (памятка, с. 23). */
export function commentHint(
  status: DispatcherStatus,
  serviceId: string | null = null,
): string {
  if (status === "completed" && serviceId && NO_REFUSAL_SERVICES.has(serviceId))
    return "результаты работ; без выезда — «Завершение работ без бригады»";
  return STATUS_COMMENT_HINTS[status];
}

/** Срок первичного статуса «Принята» / «Не принята» — 30 с (памятка ДДС, с. 5, 21). */
export const PRIMARY_STATUS_S = 30;

/**
 * Первичный статус поставлен позже срока: в АРМ время такой записи в истории и на плитке
 * службы выделено красным (памятка, с. 25). Срок считается от показа карточки службе
 * (`delivered_at`, с него же 30 с реакции у оценщика), без показа — от появления.
 * Красным отмечается только первый первичный статус: «Принята» после ошибочной
 * «Не принята» — исправление (с. 32), а не опоздание.
 */
export function latePrimaryId(
  card: Pick<Card, "appeared_at" | "delivered_at">,
  events: readonly {
    id: string;
    type: string;
    server_ts: string;
    payload: Record<string, unknown>;
  }[],
): string | null {
  const first = events.find(
    (event) =>
      event.type === "status_change" &&
      (event.payload.state === "accepted" ||
        event.payload.state === "rejected"),
  );
  if (!first) return null;
  const from = Date.parse(card.delivered_at ?? card.appeared_at);
  return Date.parse(first.server_ts) - from > PRIMARY_STATUS_S * 1000
    ? first.id
    : null;
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
  return [
    street,
    apartment,
    address.object,
    address.structure ? `стр. ${address.structure}` : "",
    address.entrance ? `подъезд ${address.entrance}` : "",
    address.floor ? `этаж ${address.floor}` : "",
    address.code ? `код ${address.code}` : "",
    address.descriptive,
  ]
    .filter(Boolean)
    .join(", ");
}

export function formatOkrug(address: Card["source"]["address"]): string {
  const parts = [address.okrug, address.district].filter(Boolean);
  return parts.length ? `${address.city}, (${parts.join(", ")})` : address.city;
}

/** Адрес одной строкой, как в реестре и карточке arm_dds/03, 06: город, (округ, район), улица. */
export function fullAddress(address: Card["source"]["address"]): string {
  return [formatOkrug(address), formatAddress(address)]
    .filter(Boolean)
    .join(", ");
}

/** Административные округа Москвы — для второй строки адреса в карточке (arm_dds/06). */
const OKRUG_NAMES: Record<string, string> = {
  ЦАО: "Центральный административный округ",
  САО: "Северный административный округ",
  СВАО: "Северо-Восточный административный округ",
  ВАО: "Восточный административный округ",
  ЮВАО: "Юго-Восточный административный округ",
  ЮАО: "Южный административный округ",
  ЮЗАО: "Юго-Западный административный округ",
  ЗАО: "Западный административный округ",
  СЗАО: "Северо-Западный административный округ",
  ЗелАО: "Зеленоградский административный округ",
  НАО: "Новомосковский административный округ",
  ТАО: "Троицкий административный округ",
};

/** Полное название округа; пусто, если округ не указан или не московский. */
export function okrugName(address: Card["source"]["address"]): string {
  return OKRUG_NAMES[address.okrug] ?? "";
}

const pad = (value: number) => String(value).padStart(2, "0");

/** Дата реестра «17.09.26» — arm_dds/03. */
export function shortDate(moment: Date): string {
  return `${pad(moment.getDate())}.${pad(moment.getMonth() + 1)}.${String(moment.getFullYear()).slice(2)}`;
}

/** Дата и время «17.09.2026 11:13:19» — лента описания и история статусов, arm_dds/06, 12. */
export function fullDateTime(moment: Date): string {
  return `${pad(moment.getDate())}.${pad(moment.getMonth() + 1)}.${moment.getFullYear()} ${clockParts(moment).hm}:${pad(moment.getSeconds())}`;
}

const WEEKDAYS = [
  "Воскресенье",
  "Понедельник",
  "Вторник",
  "Среда",
  "Четверг",
  "Пятница",
  "Суббота",
];
// Месяц в именительном падеже, как напечатано в АРМ: «17 Сентябрь 2026» (arm_dds/02).
const MONTHS = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь",
];

/** Дата над часами АРМ: «Четверг, 17 Сентябрь 2026» (arm_dds/02–05). */
export function clockDate(moment: Date): string {
  return `${WEEKDAYS[moment.getDay()]}, ${moment.getDate()} ${MONTHS[moment.getMonth()]} ${moment.getFullYear()}`;
}

/** Часы и минуты крупно, секунды отдельно — «11:17» и «40» (arm_dds/02–05). */
export function clockParts(moment: Date): { hm: string; s: string } {
  return {
    hm: `${pad(moment.getHours())}:${pad(moment.getMinutes())}`,
    s: pad(moment.getSeconds()),
  };
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
 * Телефонный compact-формат сохраняет прежнее м:сс без ограничения числа минут.
 */
export function formatDuration(
  seconds: number,
  { compact = false }: { readonly compact?: boolean } = {},
): string {
  if (!compact && seconds > 5999) return "99:59+";
  const total = Math.max(0, Math.floor(seconds));
  const minutes = String(Math.floor(total / 60));
  return `${compact ? minutes : minutes.padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
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

export interface PreviewRow {
  readonly label: string;
  readonly text: string;
}

/**
 * Предпросмотр строки реестра — «⌄» в начале строки (памятка ДДС, с. 13–14): оповещённые
 * службы и их последние статусы, заявитель, признаки происшествия. Статус чужой службы
 * контракт не передаёт: с `nowMs` — по расписанию мира, как на плитке (TC-07,
 * `otherServices.ts`), без него — время появления карточки и «Добавлена».
 */
export function previewRows(
  card: Pick<Card, "state" | "appeared_at" | "opened_at" | "source"> & {
    readonly id?: string;
  },
  services: readonly Pick<Service, "id" | "name">[],
  ownServiceId: string | null,
  ownStatusAt: string | null,
  nowMs?: number,
): PreviewRow[] {
  const time = (value: string) => {
    const moment = new Date(value);
    return `${clockParts(moment).hm}:${pad(moment.getSeconds())}`;
  };
  const name = (id: string) =>
    services.find((service) => service.id === id)?.name ?? id;
  const foreign = (id: string) => {
    if (nowMs === undefined || !card.id)
      return `${name(id)} — ${time(card.appeared_at)} ${STATE_LABELS.added}`;
    const step = otherServiceStatus(card.id, id, card.appeared_at, nowMs);
    return `${name(id)} — ${time(new Date(step.atMs).toISOString())} ${STATE_LABELS[step.state]}`;
  };
  const notified = card.source.service_ids
    .map((id) =>
      id === ownServiceId
        ? `${name(id)} — ${time(ownStatusAt ?? card.opened_at ?? card.appeared_at)} ${STATE_LABELS[card.state]}`
        : foreign(id),
    )
    .join(", ");
  const source = card.source;
  const caller = [
    [source.caller_name, source.caller_status].filter(Boolean).join(" "),
    source.phone_aon ? `АОН ${source.phone_aon}` : "",
    source.phone_provided
      ? `предоставленный телефон ${source.phone_provided}`
      : "",
  ]
    .filter(Boolean)
    .join("   ");
  return [
    { label: "Службы:", text: notified },
    { label: "Заявитель:", text: caller },
    {
      label: "Информация:",
      text: source.tags.length ? `${source.tags.join(". ")}.` : "",
    },
  ].filter((row) => row.text);
}

/**
 * Список карточек после статуса, который сервер уже принял (ответ 200 на `status_change`).
 * Состояние карточки в кэше обновляется только по `card.updated` из сокета и новому
 * запросу списка; до этого окно телефона судило по старому статусу: бригада, которой
 * позвонили сразу после «Принята», «отказывала» — вызов не назначен (e2e captain-practice,
 * ночь 17→18.10, HQ-039), хотя сервер звонок принимал. Остальные поля — из запроса.
 */
export function withConfirmedState<T extends Pick<Card, "id" | "state">>(
  cards: readonly T[] | undefined,
  cardId: string,
  state: DispatcherStatus,
): T[] | undefined {
  if (!cards) return undefined;
  return cards.map((card) =>
    card.id === cardId && card.state !== state ? { ...card, state } : card,
  );
}
