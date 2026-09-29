// Представление АРМ из card_112. Классификатор ДДС и идентификаторы маршрутизации
// остаются каноническими; дополнительные поля карточки принадлежат только экрану.
// cspell:words ЦЭМП ЦОДД БПЛА
import type { IncidentType, OperatorData, Service } from "./data";
import { retype, tagGroups, type Answers, type TagGroup } from "./model";

export const SERVICE_LABELS: Record<string, string> = {
  "101": "Служба 101",
  "102": "Служба 102",
  "103": "Служба 103",
  "104": "Служба 104",
  GKH: "Деп. ЖКХ",
  MOSLIFT: "Мослифт",
  FSB: "ФСБ",
  CEMP: "ЦЭМП",
  CODD: "ЦОДД",
  SECURITY: "Мос.Без.",
};
export const SERVICE_NAMES: Record<string, string> = {
  "101":
    'Служба 101 (ГУ МЧС России по г.Москве , ГКУ "Пожарно спасательный центр" ОДС)',
  "103":
    "Служба 103 (ГБУ города Москвы Станция скорой и неотложной медицинской помощи им.А.С. Пучкова)",
  "104": 'Служба 104 (АО "МОСГАЗ" Диспетчерское управление)',
};
export function displayServices(services: readonly Service[]): Service[] {
  const extra = ["FSB", "CEMP", "CODD", "SECURITY"].map((id) => ({
    id,
    name: SERVICE_LABELS[id]!,
  }));
  return [...services, ...extra].map((s) => ({
    ...s,
    name: SERVICE_NAMES[s.id] ?? SERVICE_LABELS[s.id] ?? s.name,
  }));
}
export const SERVICE_ORDER = [
  "101",
  "104",
  "102",
  "GKH",
  "CEMP",
  "CODD",
  "SECURITY",
  "MOSLIFT",
  "103",
  "FSB",
];
export const DIALOG_ORDER = [
  "101",
  "FSB",
  "CEMP",
  "103",
  "104",
  "102",
  "GKH",
  "CODD",
  "SECURITY",
  "MOSLIFT",
];

export const TYPE_GROUPS = [
  "101",
  "102",
  "103",
  "104",
  "Аварии и происшествия в городском хозяйстве",
  "Аварии на гидротехнических сооружениях",
  "Аварии на опасных и производственных объектах",
  "Благодарность службам",
  "БПЛА",
  "Взрыв",
];
export function groupChoice(
  data: OperatorData,
  label: string,
): IncidentType | undefined {
  if (label === "101") return data.types.find((t) => t.code === "1050001");
  if (label === "104")
    return data.types.find((t) => t.mainService === "MOSGAZ");
  if (label === "Взрыв") return data.types.find((t) => t.groupNo === "3");
  return undefined;
}
export function cardTitle(type: IncidentType): string {
  if (type.groupNo === "3") return "П: Взрыв";
  if (type.groupNo === "1") return "Происшествие 101";
  if (type.mainService === "MOSGAZ") return "Происшествие 104";
  return type.name;
}
export interface CardGroup extends TagGroup {
  readonly input?: boolean;
  readonly multi?: boolean;
}
export function cardGroups(
  data: OperatorData,
  type: IncidentType,
  answers: Answers,
): CardGroup[] {
  const row = (
    key: string,
    title: string,
    values: string[],
    fallback = "",
    multi = false,
  ): CardGroup => ({
    key,
    title,
    multi,
    input: values.length === 0,
    options: values.map((value) => ({
      value,
      selected: multi
        ? (answers[key] ?? fallback).split("|").includes(value)
        : (answers[key] ?? fallback) === value,
    })),
  });
  const threat = row("victims", "Угроза людям", ["Да", "Нет"]);
  if (type.groupNo === "3")
    return [
      row("explosion_place", "Где взрыв", [
        "Здание / Объект",
        "Транспорт",
        "Звуки похожие на взрыв, что взорвалось сообщить не может",
      ]),
      row("fire", "Есть возгорание", ["Да", "Нет"]),
      row("collapse", "Есть угроза обрушения", ["Да", "Нет"]),
      row("damage", "Какие видят разрушения", []),
    ];
  if (type.mainService === "MOSGAZ")
    return [
      row("gas_sign", "Признаки происшествия", [
        "Запах газа вне помещения (на улице)",
        "Запах газа в помещении (в квартире, в доме)",
        "Нарушение в работе газового оборудования",
        "Повреждение газопровода",
        "Повышенное давление газа",
      ]),
      threat,
    ];
  if (type.signs[0] !== "жилой дом") return tagGroups(data, type, answers);
  const object = type.signs[1];
  const capitalized = object ? object[0]!.toUpperCase() + object.slice(1) : "";
  return [
    row(
      "fire_place",
      "Где",
      ["Улица", "Транспорт", "Дом", "Здание / объект", "Опасный объект"],
      "Дом",
    ),
    row(
      "fire_sign",
      "Признак пожара (дом)",
      ["Открытое пламя / Дым", "Запах гари", "Сработала пожарная сигнализация"],
      type.signs[2] === "запах гари"
        ? "Запах гари"
        : object === "сигнализация"
          ? "Сработала пожарная сигнализация"
          : "Открытое пламя / Дым",
    ),
    row("no_access", "Доступ", ["Нет доступа"]),
    row(
      "house_kind",
      "Дом (пламя, дым)",
      [
        "Дом многоквартирный",
        "Дом частный",
        "Дача",
        "Сарай / бытовка / хоз. постройка",
        "Выселенное здание",
      ],
      "Дом многоквартирный",
    ),
    row("building_floors", "Этажность здания", []),
    threat,
    row(
      "house_objects",
      "Внутридомовые объекты (пламя, дым)",
      [
        "Квартира",
        "Балкон",
        "Газовая колонка",
        "Газовая плита",
        "Лифт",
        "Мусоропровод",
        "Подъезд",
        "Счетчик электричества",
        "Электрическая проводка",
        "Электрощит",
        "Лестничная клетка",
        "Подвал",
        "Прочие внутридомовые объекты",
        "Крыша",
      ],
      capitalized,
      true,
    ),
    row("traffic_blocked", "Есть ли перекрытие движения", ["Да", "Нет"]),
    row("gasification", "Проведена ли газификация", [
      "Да",
      "Нет",
      "Нет данных",
    ]),
    row("card_description", "Описание", []),
  ];
}

export function cardAnswer(
  answers: Answers,
  group: CardGroup,
  value: string,
): Answers {
  if (!group.multi)
    return {
      ...answers,
      [group.key]: answers[group.key] === value ? "" : value,
    };
  const selected = new Set(
    group.options.filter((o) => o.selected).map((o) => o.value),
  );
  if (!selected.delete(value)) selected.add(value);
  return { ...answers, [group.key]: [...selected].join("|") };
}

/** Кнопки АРМ уточняют канонический тип, поэтому оценка и службы видят тот же выбор. */
export function cardType(
  data: OperatorData,
  type: IncidentType,
  key: string,
  value: string,
): IncidentType {
  if (key.startsWith("sign"))
    return retype(data, type, Number(key.slice(4)) - 1, value);
  if (key === "house_objects")
    return retype(data, type, 1, value.toLowerCase());
  if (key === "fire_sign") {
    if (value === "Сработала пожарная сигнализация")
      return data.types.find((t) => t.code === "1051600") ?? type;
    return retype(
      data,
      type,
      2,
      value === "Запах гари" ? "запах гари" : "открытое пламя",
    );
  }
  if (key === "fire_place") {
    const where: Record<string, string> = {
      Улица: "на улице",
      Транспорт: "транспорт",
      Дом: "жилой дом",
      "Опасный объект": "опасный объект",
    };
    return retype(data, type, 0, where[value] ?? value);
  }
  if (key === "house_kind") {
    const objects: Record<string, string> = {
      "Дом частный": "частный дом",
      Дача: "дача",
      "Дом многоквартирный": "",
    };
    if (value in objects) return retype(data, type, 1, objects[value]!);
  }
  const code =
    key === "gas_sign"
      ? (
          {
            "Запах газа вне помещения (на улице)": "13010400",
            "Запах газа в помещении (в квартире, в доме)": "13020201",
            "Нарушение в работе газового оборудования": "13030100",
            "Повреждение газопровода": "13040100",
          } as Record<string, string>
        )[value]
      : key === "explosion_place"
        ? (
            {
              "Здание / Объект": "3010100",
              Транспорт: "3021100",
              "Звуки похожие на взрыв, что взорвалось сообщить не может":
                "3030000",
            } as Record<string, string>
          )[value]
        : undefined;
  return data.types.find((t) => t.code === code) ?? type;
}
