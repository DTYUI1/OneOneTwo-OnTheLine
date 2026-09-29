// Модель экрана оператора 112 (docs/screenshots/card_112/01–03): поиск типа,
// теги опросной карты, подстановка служб по routing_rules, таймер и счётчик.

import type { IncidentType, OperatorData, Service } from "./data";

/** Настройки модуля. Норматив по умолчанию — как у карточки 112 (data/seed/settings.json). */
export const OPERATOR_SETTINGS = {
  normativeS: 180,
  timerWarningS: 80,
} as const;

export const DESCRIPTION_LIMIT = 1999;

/** Быстрые кнопки поля «что случилось?» — как на скриншоте 01. */
export const FREQUENT_TYPES = [
  "ДТП",
  "Ошибочно набран номер",
  "104",
  "Человек в опасности",
  "Отмена вызова",
  "Тестовый вызов",
  "Передача дежурства",
  "Консультация",
  "Вызов на иностранном языке",
  "Справка-101",
] as const;

/** main_service_code → служба (contracts/data_formats.md). */
const MAIN_SERVICE: Record<string, string> = {
  MCHS: "101",
  Police: "102",
  AMBULANCE: "103",
  MOSGAZ: "104",
  GKH: "GKH",
  MOSLIFT: "MOSLIFT",
};

export function mainService(type: IncidentType): string | null {
  return MAIN_SERVICE[type.mainService] ?? null;
}

const normalize = (value: string) => value.toLowerCase().replaceAll("ё", "е");

/** Типы, в названии, группе или службе которых есть все слова запроса. */
export function searchTypes(
  data: OperatorData,
  query: string,
  limit = 30,
): IncidentType[] {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return data.types
    .filter((type) => {
      const text = normalize(
        `${type.name} ${type.groupName} ${mainService(type) ?? ""}`,
      );
      return words.every((word) => text.includes(word));
    })
    .slice(0, limit);
}

/** Выбор в поле «что случилось?»: тип классификатора или звонок без происшествия. */
export type Choice =
  | { readonly kind: "type"; readonly code: string }
  | { readonly kind: "call"; readonly label: string };

/** Быстрая кнопка: тип из классификатора — в поиск, иначе звонок без происшествия. */
export function frequentChoice(
  data: OperatorData,
  label: string,
): { query: string } | { choice: Choice } {
  return searchTypes(data, label, 1).length > 0
    ? { query: label }
    : { choice: { kind: "call", label } };
}

export function incidentTitle(type: IncidentType): string {
  return `Происшествие ${mainService(type) ?? type.mainService}`;
}

export interface TagOption {
  readonly value: string;
  readonly selected: boolean;
}
export interface TagGroup {
  readonly key: string;
  readonly title: string;
  readonly options: readonly TagOption[];
}

/** Теги маршрутизации: название группы, ответы и ответ, включающий тег. */
const TRIGGER_GROUPS: Record<
  string,
  { title: string; options: string[]; on: string }
> = {
  victims: { title: "Пострадавшие", options: ["Да", "Нет"], on: "Да" },
  no_access: { title: "Доступ", options: ["Нет доступа"], on: "Нет доступа" },
  offense: { title: "Правонарушение", options: ["Да", "Нет"], on: "Да" },
  gasification: {
    title: "Проведена ли газификация",
    options: ["Да", "Нет", "Нет данных"],
    on: "Да",
  },
};
const SIGN_TITLES = ["Где", "Объект", "Признак"] as const;

/** Ответы опросной карты: ключ группы → выбранный тег. */
export type Answers = Readonly<Record<string, string>>;

export function activeTags(answers: Answers): Set<string> {
  return new Set(
    Object.entries(TRIGGER_GROUPS)
      .filter(([key, group]) => answers[key] === group.on)
      .map(([key]) => key),
  );
}

/** Включить или снять тег (кнопки «Пострадавшие», «Нет доступа/Заблокированные»). */
export function toggleTag(answers: Answers, tag: string): Answers {
  const group = TRIGGER_GROUPS[tag];
  if (!group) return answers;
  const next = { ...answers };
  if (next[tag] === group.on) delete next[tag];
  else next[tag] = group.on;
  return next;
}

/** Теги кнопок справа («Пострадавшие», «Нет доступа») видны при любом типе. */
const QUICK_TAGS: readonly string[] = ["victims", "no_access"];

/**
 * Смена или сброс типа: ответы карточки прежнего типа снимаются, а отметки кнопок справа
 * остаются — иначе «Пострадавшие», нажатые до выбора типа, молча пропадают вместе со
 * скорой на полосе «Службы:».
 */
export function keepQuickTags(answers: Answers): Answers {
  return Object.fromEntries(
    Object.entries(answers).filter(([key]) => QUICK_TAGS.includes(key)),
  );
}

/** Ответ в группе тегов: повторный выбор снимает тег. */
export function answer(answers: Answers, key: string, value: string): Answers {
  const next = { ...answers };
  if (next[key] === value) delete next[key];
  else next[key] = value;
  return next;
}

function sameGroup(data: OperatorData, type: IncidentType) {
  return data.types.filter((item) => item.groupNo === type.groupNo);
}

/** Группы тегов: признаки классификатора и теги, от которых зависят службы. */
export function tagGroups(
  data: OperatorData,
  type: IncidentType,
  answers: Answers,
): TagGroup[] {
  const group = sameGroup(data, type);
  const signs: TagGroup[] = SIGN_TITLES.map((title, level) => {
    const values = group
      .filter((item) =>
        item.signs.slice(0, level).every((sign, i) => sign === type.signs[i]),
      )
      .map((item) => item.signs[level])
      .filter((value): value is string => Boolean(value));
    return {
      key: `sign${level + 1}`,
      title,
      options: [...new Set(values)].map((value) => ({
        value,
        selected: value === type.signs[level],
      })),
    };
  }).filter((item) => item.options.length > 0);
  const triggers = new Set(
    data.rules
      .filter((rule) => rule.typeCode === type.code)
      .map((rule) => rule.trigger),
  );
  const tags = Object.entries(TRIGGER_GROUPS)
    .filter(([key]) => triggers.has(key))
    .map(([key, item]) => ({
      key,
      title: item.title,
      options: item.options.map((value) => ({
        value,
        selected: answers[key] === value,
      })),
    }));
  return [...signs, ...tags];
}

/** Тег-признак уточняет тип: берётся тип той же группы с этим признаком. */
export function retype(
  data: OperatorData,
  type: IncidentType,
  level: number,
  value: string,
): IncidentType {
  const candidates = sameGroup(data, type).filter(
    (item) =>
      item.signs[level] === value &&
      item.signs.slice(0, level).every((sign, i) => sign === type.signs[i]),
  );
  const score = (item: IncidentType) =>
    item.signs.filter((sign, i) => i > level && sign === type.signs[i]).length;
  return (
    candidates.reduce<IncidentType | undefined>(
      (best, item) => (!best || score(item) > score(best) ? item : best),
      undefined,
    ) ?? type
  );
}

/** Службы по routing_rules: правило действует, если trigger — default или тег выбран. */
export function autoServices(
  data: OperatorData,
  typeCode: string | null,
  tags: ReadonlySet<string>,
): string[] {
  if (!typeCode) return [];
  const ids = new Set(
    data.rules
      .filter(
        (rule) =>
          rule.typeCode === typeCode &&
          (rule.trigger === "default" || tags.has(rule.trigger)),
      )
      .map((rule) => rule.serviceId),
  );
  return data.services
    .filter((service) => ids.has(service.id))
    .map((s) => s.id);
}

/** Службы полосы «Службы:»: подставленные без снятых вручную плюс добавленные. */
export function barServices(
  services: readonly Service[],
  auto: readonly string[],
  added: ReadonlySet<string>,
  removed: ReadonlySet<string>,
): Service[] {
  return services.filter(
    (service) =>
      added.has(service.id) ||
      (auto.includes(service.id) && !removed.has(service.id)),
  );
}

/** Окно «Добавьте службы» сохранено: отмеченные — на полосе, снятые — убраны. */
export function saveServices(
  auto: readonly string[],
  checked: ReadonlySet<string>,
): { added: Set<string>; removed: Set<string> } {
  return {
    added: new Set([...checked].filter((id) => !auto.includes(id))),
    removed: new Set(auto.filter((id) => !checked.has(id))),
  };
}

export function searchServices(
  services: readonly Service[],
  query: string,
): Service[] {
  const text = normalize(query.trim());
  return services.filter((service) =>
    normalize(`${service.name} ${service.id}`).includes(text),
  );
}

export function descriptionCounter(text: string): string {
  return `${text.length} / ${DESCRIPTION_LIMIT}`;
}

export function formatTimer(seconds: number): [string, string] {
  const safe = Math.max(0, Math.floor(seconds));
  return [
    String(Math.floor(safe / 60)).padStart(2, "0"),
    String(safe % 60).padStart(2, "0"),
  ];
}

export function isOverdue(
  seconds: number,
  normativeS: number = OPERATOR_SETTINGS.normativeS,
): boolean {
  return seconds > normativeS;
}

/** +79161234567 → +7 (916) 123-45-67; иное — как есть. */
export function formatPhone(phone: string): string {
  const match = /^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(phone);
  return match ? `+7 (${match[1]}) ${match[2]}-${match[3]}-${match[4]}` : phone;
}

export interface Address {
  readonly country: string;
  readonly subject: string;
  readonly locality: string;
  readonly object: string;
  readonly okrug: string;
  readonly district: string;
  readonly street: string;
  readonly house: string;
  readonly korpus: string;
  readonly structure: string;
  readonly apartment: string;
  readonly entrance: string;
  readonly floor: string;
  readonly code: string;
  readonly descriptive: string;
}

export const EMPTY_ADDRESS: Address = {
  country: "",
  subject: "Москва",
  locality: "",
  object: "",
  okrug: "",
  district: "",
  street: "",
  house: "",
  korpus: "",
  structure: "",
  apartment: "",
  entrance: "",
  floor: "",
  code: "",
  descriptive: "",
};

/** Строка «Адрес:» над формой — непустые части через запятую. */
export function addressLine(address: Address): string {
  const parts: [string, string][] = [
    ["", address.subject],
    ["", address.locality],
    ["", address.street],
    ["д. ", address.house],
    ["корп. ", address.korpus],
    ["стр. ", address.structure],
    ["кв. ", address.apartment],
  ];
  return parts
    .filter(([, value]) => value.trim())
    .map(([prefix, value]) => prefix + value.trim())
    .join(", ");
}
