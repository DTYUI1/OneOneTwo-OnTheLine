// Доклад службе по частям — запасной путь к докладу голосом (DT-05, voiceReport.ts; GP-06).
// Порядок доклада — памятка ДДС, с. 32 (DT-11): кто вы, адрес и повод, карточка, что
// изменилось. Для звонка руководителю и в другие службы памятка своего порядка не даёт —
// берём тот же, но без карточки: её памятка требует только в звонке в 112 (допущение,
// tasks/DT-11-report-scheme.md).
// По частям (docs/dds_gameplay.md, раздел 6): шаг на часть, на шаге до трёх коротких
// вариантов — верный из карточки и похожие ошибки (parts.ts). Оценка — те же части, что у
// голоса: неверная часть не прозвучала, служба её переспросит.
// Чистые функции: окно разговора только подставляет карточку, решения проверяются тестами.
// Тон деловой: сведения и просьбы, без оценок и эмоций.

import type { Card } from "../../shared/api";
import type { CardState } from "../cardModel";
import { bankText } from "./bank";
import {
  addressOptions,
  incidentOptions,
  similarNumber,
  stepOptions,
  type PartStep,
} from "./parts";

/**
 * Вид доклада. Совпадает с `call_hangup.report_choices` контракта и `evalcore.REPORT_GAPS`.
 * Неполный — без первой недостающей части памятки. Старые `no_victims` и `no_incident`
 * остаются только в журналах до 08.10.2026, окно разговора их не пишет.
 */
export type ReportChoice =
  | "full"
  | "no_who"
  | "no_address"
  | "no_card"
  | "no_change"
  | "extra";

/** Часть доклада по памятке ДДС, с. 32 (`call_hangup.report_parts`). */
export type ReportPart = "who" | "address" | "card" | "change";

/** Части в порядке памятки и как они называются в окне и разборе. */
export const REPORT_PARTS: readonly { part: ReportPart; label: string }[] = [
  { part: "who", label: "кто вы" },
  { part: "address", label: "адрес и повод" },
  { part: "card", label: "карточка" },
  { part: "change", label: "что изменилось" },
];

/** Номер 112 в справочнике: только в этом звонке доклад называет карточку. */
export const CARD_REPORT_EXT = "112";

const ALL_PARTS: readonly ReportPart[] = REPORT_PARTS.map(({ part }) => part);

/**
 * Обязательные части доклада по номеру собеседника: карточка — только для 112, как
 * `evalcore.criteria.required_parts`. Номер не известен — все части.
 */
export function requiredParts(
  phoneExt: string | null | undefined,
): readonly ReportPart[] {
  if (!phoneExt || phoneExt === CARD_REPORT_EXT) return ALL_PARTS;
  return ALL_PARTS.filter((part) => part !== "card");
}

/** Какой части нет в неполном докладе. */
const MISSING: Partial<Record<ReportChoice, ReportPart>> = {
  no_who: "who",
  no_address: "address",
  no_card: "card",
  no_change: "change",
};

/** Части доклада по его виду: полный и с лишним — все четыре, неполный — без одной. */
export function partsOf(choice: ReportChoice): ReportPart[] {
  return REPORT_PARTS.map(({ part }) => part).filter(
    (part) => part !== MISSING[choice],
  );
}

/**
/**
 * Доклад за звонок: услышанное раньше остаётся, новое добавляется — в порядке памятки, как
 * их пишет отбой (`call_hangup.report_parts`). На «Представьтесь» отвечают одной частью, и
 * названные раньше адрес и повод не теряются (стенд 17.10).
 */
export function heardSoFar(
  before: Iterable<ReportPart>,
  now: Iterable<ReportPart>,
): ReportPart[] {
  const said = new Set([...before, ...now]);
  return REPORT_PARTS.map(({ part }) => part).filter((part) => said.has(part));
}

/**
 * Вид доклада по прозвучавшим частям: первая недостающая обязательная часть по порядку
 * памятки или `full`.
 */
export function choiceOf(
  parts: Iterable<ReportPart>,
  required: readonly ReportPart[] = ALL_PARTS,
): ReportChoice {
  const said = new Set(parts);
  const missing = required.find((part) => !said.has(part));
  if (!missing) return "full";
  const gap = (Object.keys(MISSING) as ReportChoice[]).find(
    (choice) => MISSING[choice] === missing,
  );
  return gap ?? "full";
}

/**
 * Строка памятки ДДС, с. 32 («Ситуация на месте происшествия отличается от изначально
 * заявленной либо изменилась, требуется вызов других служб»), дословно — без начала
 * «Позвонить по номеру «112»»: номер обучаемый выбирает сам.
 */
export const REPORT_MEMO =
  "представиться (ФИО, должность, служба), назвать адрес места происшествия и повод для вызова, сообщить, что служба проводит работы по ранее направленной из системы-112 карточке (можно сообщить номер), сообщить об изменении ситуации, ответить на вопросы оператора";
export const REPORT_MEMO_SOURCE = "Памятка ДДС, с. 32";

/** Сведения карточки, из которых складывается доклад. */
export interface ReportFacts {
  /** ФИО обучаемого; пусто — не известно. */
  readonly trainee: string;
  /** Служба обучаемого, как в справочнике: «Служба 102»; пусто — не известна. */
  readonly service: string;
  readonly number: string;
  readonly incident: string;
  readonly address: Card["source"]["address"];
  readonly victims: boolean;
  readonly blockedPeople: boolean;
  readonly state: CardState | null;
  /** Названия направленных бригад. */
  readonly brigades: readonly string[];
}

/**
 * Что дежурный переспрашивает: часть памятки, а у «адреса и повода» — чего именно не хватило
 * (`place` — адреса, `reason` — повода).
 */
export type ReportAsk = "who" | "place" | "reason" | "card" | "change";

/** Чего не хватило в части «адрес и повод» (`VoiceReport.address_gap`). */
export type AddressGap = "place" | "reason";

/**
 * Переспрос службы о недостающей части доклада — фразы банка общего дежурного (GP-25,
 * `OFFICIAL.json`): свой текст в коде не пишется. Один вопрос на одну недостающую вещь.
 * Фраза с новой редакцией (`revisions/OFFICIAL.json`, HQ-037) — id редакции: старая после
 * записи редакции из выборки окна телефона уходит.
 */
export const ASK_IDS: Record<ReportAsk, string> = {
  who: "OFFICIAL.ask_who.any.1",
  place: "OFFICIAL.ask_address.any.1",
  reason: "OFFICIAL.ask_what.any.5",
  card: "OFFICIAL.ask_card.any.4",
  change: "OFFICIAL.ask_what.any.6",
};

/**
 * Что переспросить: первая недостающая часть по порядку памятки — одна, как в эталоне
 * банка («переспрос одним вопросом, если чего-то не хватило»). У адреса и повода — то, чего
 * не хватило (`gap`; не известно — адрес). Все части есть — `null`.
 */
export function nextAsk(
  said: Iterable<ReportPart>,
  gap: AddressGap | null = null,
  required: readonly ReportPart[] = ALL_PARTS,
): ReportAsk | null {
  const have = new Set(said);
  const missing = required.find((part) => !have.has(part));
  if (!missing) return null;
  return missing === "address" ? (gap ?? "place") : missing;
}

/** Уточняющий вопрос службы на неполный доклад: чего не хватило. */
export const CLARIFY: Record<
  Exclude<ReportChoice, "full" | "extra">,
  string
> = {
  no_who: bankText(ASK_IDS.who),
  no_address: bankText(ASK_IDS.place),
  no_card: bankText(ASK_IDS.card),
  no_change: bankText(ASK_IDS.change),
};

/**
 * Вопрос службы на доклад: одна фраза банка о первой недостающей части (`nextAsk`).
 * Ответ на него складывается с прежним (доклад за звонок), так что следующий вопрос — уже о
 * следующей части. Все части есть — `null`.
 */
export function clarifyFor(
  said: Iterable<ReportPart>,
  gap: AddressGap | null = null,
  required: readonly ReportPart[] = ALL_PARTS,
): string | null {
  const ask = nextAsk(said, gap, required);
  return ask === null ? null : bankText(ASK_IDS[ask]);
}

function victimsText(victims: boolean, blockedPeople: boolean): string {
  const text = victims ? "Есть пострадавшие" : "Пострадавших нет";
  return blockedPeople ? `${text}, есть заблокированные` : text;
}

/** Какие силы направлены или что решено — конец части «что изменилось». */
function forcesText(facts: ReportFacts): string {
  const names = facts.brigades.map((name) =>
    name.replace(/^Бригада(?=\s|$)/u, "бригада"),
  );
  if (names.length === 1) return `направлена ${names[0]}`;
  if (names.length > 1) return `направлены: ${names.join(", ")}`;
  if (facts.state === "accepted") return "силы назначаются";
  if (facts.state === "added" || facts.state === "received" || !facts.state)
    return "решение по силам принимается";
  return "работы идут";
}

/** Шаг доклада по частям (GP-06). Адрес и повод — одна часть памятки, два шага. */
export type ReportStepKey = "who" | "address" | "what" | "card" | "change";

const STEP_PART: Record<ReportStepKey, ReportPart> = {
  who: "who",
  address: "address",
  what: "address",
  card: "card",
  change: "change",
};

export type ReportStep = PartStep<ReportStepKey>;

/**
 * Доклад службе по частям — запасной путь к голосу (раздел 6 эталона): шаги обязательных
 * частей памятки (`required`), ещё не прозвучавших в этом звонке (`said`), на шаге до трёх коротких вариантов — верный из
 * карточки и ошибки, какие делает живой человек: не представился, буква в улице и цифра в
 * доме, другое происшествие, не тот номер карточки, обстановка наоборот или «остальное — в
 * карточке». Адрес уже прозвучал, не хватило повода (`gap` — `reason`) — шага «Адрес» нет:
 * круг начинается с «Что случилось», о чём служба и спросила.
 */
export function reportSteps(
  facts: ReportFacts,
  seed: string,
  said: Iterable<ReportPart> = [],
  required: readonly ReportPart[] = ALL_PARTS,
  gap: AddressGap | null = null,
): readonly ReportStep[] {
  const have = new Set(said);
  const who = ["Диспетчер", facts.trainee].filter(Boolean).join(" ");
  const change = `${victimsText(facts.victims, facts.blockedPeople)}, ${forcesText(facts)}`;
  const steps: ReportStep[] = [
    {
      key: "who",
      label: "Кто вы",
      options: stepOptions(
        [who, facts.service].filter(Boolean).join(", "),
        [facts.trainee ? facts.service : null, "Звоню по вызову"],
        `${seed}:who`,
      ),
    },
    {
      key: "address",
      label: "Адрес",
      options: addressOptions(facts.address, seed),
    },
    {
      key: "what",
      label: "Что случилось",
      options: incidentOptions(facts.incident, seed),
    },
    {
      key: "card",
      label: "Карточка",
      options: stepOptions(
        `Работаем по карточке ${facts.number}`,
        [
          `Работаем по карточке ${similarNumber(facts.number)}`,
          "Звоню по новому вызову",
        ],
        `${seed}:card`,
      ),
    },
    {
      key: "change",
      label: "Что изменилось",
      options: stepOptions(
        change,
        [
          `${victimsText(!facts.victims, facts.blockedPeople)}, ${forcesText(facts)}`,
          "Остальное — в карточке",
        ],
        `${seed}:change`,
      ),
    },
  ];
  return steps.filter(
    (step) =>
      required.includes(STEP_PART[step.key]) &&
      !have.has(STEP_PART[step.key]) &&
      !(step.key === "address" && gap === "reason"),
  );
}

/** Выбранная часть доклада: шаг и верен ли вариант. */
export interface ReportPick {
  readonly key: ReportStepKey;
  readonly correct: boolean;
}

/**
 * Части памятки, которые прозвучали верно: адрес и повод — только если оба шага верны.
 * Неверная часть («Бубнинская, 124») не засчитана — служба переспросит её, как у голоса.
 */
export function pickedParts(picks: readonly ReportPick[]): ReportPart[] {
  return REPORT_PARTS.map(({ part }) => part).filter((part) => {
    const mine = picks.filter((pick) => STEP_PART[pick.key] === part);
    return mine.length > 0 && mine.every((pick) => pick.correct);
  });
}

/**
 * Чего не хватило в адресе и поводе в круге по частям: шага адреса нет или он неверен —
 * адреса, иначе неверен повод. Часть прозвучала — `null`. `addressHeard` — адрес уже
 * прозвучал в звонке, и шага «Адрес» в круге нет (`reportSteps` с `gap` — `reason`).
 */
export function pickedGap(
  picks: readonly ReportPick[],
  addressHeard = false,
): AddressGap | null {
  const address = picks.filter((pick) => pick.key === "address");
  const placeMissing =
    address.length === 0
      ? !addressHeard
      : address.some((pick) => !pick.correct);
  if (placeMissing) return "place";
  const what = picks.filter((pick) => pick.key === "what");
  return what.length === 0 || what.some((pick) => !pick.correct)
    ? "reason"
    : null;
}

/** Сведения доклада из карточки, направленных бригад и того, кто докладывает. */
export function reportFacts(
  card: Pick<Card, "source" | "state">,
  brigades: readonly string[],
  speaker: { readonly trainee?: string; readonly service?: string } = {},
): ReportFacts {
  return {
    trainee: speaker.trainee?.trim() ?? "",
    service: speaker.service?.trim() ?? "",
    number: card.source.number,
    incident: card.source.incident_class || card.source.description,
    address: card.source.address,
    victims: card.source.victims,
    blockedPeople: card.source.blocked_people,
    state: card.state,
    brigades,
  };
}
