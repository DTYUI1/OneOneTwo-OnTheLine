// Разминка (DT-09): короткие упражнения на один навык между занятиями, в своём темпе.
// По решению тимлида 03.10 в срок — два: «Найди отличие в адресе» и «Кого направить».
// Результат сохраняется на сервере (POST /warmups); ошибки прошлой разминки идут первыми —
// повторение с промежутками запоминается лучше перечитывания (разбор капитана, §4.2).
//
// Задания «Кого направить» — настоящие происшествия тренировки: data/practice/*.json,
// описание и службы карточки. Образ web собирается без data/, поэтому здесь копия
// (routing.json); её собирает и сверяет warmupModel.test.ts
// (UPDATE_WARMUP_ROUTING=1 pnpm test).

import routingCopy from "./routing.json";

export type WarmupKind = "address" | "routing";

export interface AddressPair {
  readonly a: string;
  readonly b: string;
  readonly same: boolean;
  /** Почему разные — показывается после ответа. */
  readonly note: string;
}

// Пары — типичные ошибки адреса в Москве: похожие улицы, корпус и строение,
// переставленные цифры, литера, номер в названии улицы.
export const ADDRESS_PAIRS: readonly AddressPair[] = [
  {
    a: "ул. Дубнинская, д. 32",
    b: "ул. Дубининская, д. 32",
    same: false,
    note: "Дубнинская — САО, Дубининская — ЦАО и ЮАО: другой конец города.",
  },
  {
    a: "Бескудниковский б-р, д. 24, кв. 115",
    b: "Бескудниковский б-р, д. 24, кв. 115",
    same: true,
    note: "",
  },
  {
    a: "Кутузовский пр-т, д. 30, корп. 2",
    b: "Кутузовский пр-т, д. 30, стр. 2",
    same: false,
    note: "Корпус и строение — разные здания.",
  },
  {
    a: "ул. Профсоюзная, д. 104",
    b: "ул. Профсоюзная, д. 140",
    same: false,
    note: "Переставлены цифры номера дома.",
  },
  {
    a: "Ленинский пр-т, д. 45",
    b: "Ленинградский пр-т, д. 45",
    same: false,
    note: "Ленинский — юго-запад, Ленинградский — север.",
  },
  {
    a: "2-я Владимирская ул., д. 8",
    b: "3-я Владимирская ул., д. 8",
    same: false,
    note: "Номер в названии улицы — другая улица.",
  },
  {
    a: "Краснодонская ул., д. 14",
    b: "Краснодарская ул., д. 14",
    same: false,
    note: "Две разные улицы в одном районе.",
  },
  {
    a: "Варшавское ш., д. 87",
    b: "Варшавское ш., д. 87Б",
    same: false,
    note: "Литера — другой дом.",
  },
  {
    a: "Дмитровское ш., д. 13, кв. 41",
    b: "Дмитровское ш., д. 13, кв. 41",
    same: true,
    note: "",
  },
  {
    a: "Мичуринский пр-т, д. 9, корп. 1",
    b: "Мичуринский пр-т, д. 9, корп. 1",
    same: true,
    note: "",
  },
  {
    a: "ул. Мира, д. 5, кв. 12",
    b: "пр-т Мира, д. 5, кв. 12",
    same: false,
    note: "Улица и проспект — разные адреса.",
  },
  {
    a: "Ореховый б-р, д. 7, корп. 3",
    b: "Ореховый б-р, д. 7, корп. 3",
    same: true,
    note: "",
  },
];

/** Пара — строкой: так она хранится в ошибках результата и возвращается первой. */
export const pairId = (pair: AddressPair): string => `${pair.a} / ${pair.b}`;

export interface RoutingItem {
  /** Ключ происшествия тренировки (data/practice: key). */
  readonly key: string;
  readonly text: string;
  /** Службы карточки — их и нужно направить. */
  readonly services: readonly string[];
}

export interface PracticeIncident {
  readonly key: string;
  readonly order: number;
  readonly card: {
    readonly description: string;
    readonly service_ids: readonly string[];
  };
}

/** Копия для бандла: задания «Кого направить» из data/practice, по порядку. */
export function routingItems(
  incidents: readonly PracticeIncident[],
): RoutingItem[] {
  return [...incidents]
    .sort((a, b) => a.order - b.order)
    .map((incident) => ({
      key: incident.key,
      text: incident.card.description,
      services: [...incident.card.service_ids],
    }));
}

export const ROUTING: readonly RoutingItem[] = routingCopy as RoutingItem[];

/** Ошибка «Кого направить» — ключ происшествия и нужные службы. */
export const routingMistake = (item: RoutingItem): string =>
  `${item.key}: ${item.services.join(", ")}`;

/**
 * Ошибка — словами для итогов. Хранится она ключом (по нему задание возвращается
 * первым), а показывается первой фразой происшествия и названиями служб.
 */
export function mistakeText(
  mistake: string,
  serviceName: (id: string) => string,
): string {
  const item = ROUTING.find((one) => mistake.startsWith(`${one.key}:`));
  if (!item) return mistake;
  const lead = item.text.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? item.text;
  return `${lead} Нужно: ${item.services.map(serviceName).join(", ")}.`;
}

/** Ответ верен, только если отмечены ровно нужные службы. */
export function routingCorrect(
  item: RoutingItem,
  picked: readonly string[],
): boolean {
  return (
    picked.length === item.services.length &&
    item.services.every((service) => picked.includes(service))
  );
}

/**
 * Порядок заданий: сначала те, где в прошлый раз ошиблись, остальные — перемешаны.
 * `missedIds` — ошибки последнего результата этого упражнения.
 */
export function withMissedFirst<T>(
  items: readonly T[],
  id: (item: T) => string,
  missedIds: readonly string[],
  random: () => number = Math.random,
): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const missed = (item: T) =>
    missedIds.some(
      (value) => value === id(item) || value.startsWith(`${id(item)}:`),
    );
  return [
    ...shuffled.filter(missed),
    ...shuffled.filter((item) => !missed(item)),
  ];
}

export interface SavedResult {
  readonly kind: WarmupKind;
  readonly correct: number;
  readonly total: number;
  readonly duration_ms: number;
  readonly mistakes: readonly string[];
  readonly created_at: string;
}

/** Лучший результат: больше верных, при равенстве — быстрее. */
export function bestResult(
  results: readonly SavedResult[],
  kind: WarmupKind,
): SavedResult | null {
  let best: SavedResult | null = null;
  for (const result of results) {
    if (result.kind !== kind) continue;
    const share = result.correct / result.total;
    const bestShare = best ? best.correct / best.total : -1;
    if (
      !best ||
      share > bestShare ||
      (share === bestShare && result.duration_ms < best.duration_ms)
    )
      best = result;
  }
  return best;
}

/** Ошибки последней разминки этого упражнения — вернуть их первыми. */
export function lastMistakes(
  results: readonly SavedResult[],
  kind: WarmupKind,
): readonly string[] {
  const last = [...results]
    .filter((result) => result.kind === kind)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  return last ? last.mistakes : [];
}

/** «8 из 10 за 1:14» — результат словами. */
export function scoreText(
  result: Pick<SavedResult, "correct" | "total" | "duration_ms">,
): string {
  const seconds = Math.round(result.duration_ms / 1000);
  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return `${result.correct} из ${result.total} за ${time}`;
}
