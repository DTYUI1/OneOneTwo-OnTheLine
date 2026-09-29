// Разговор с заявителем: варианты вопросов, действия оператора и запрос к API
// (contracts/operator/dialog.md). Уровень паники хранится, но цифрой не показывается —
// только тоном голоса (TONES). Этап 2: «Успокоить», «Я вас слышу, записываю», советы,
// пауза оператора и ухудшение ситуации; время считает веб. Этап 3: вопросы по шагам
// опроса вместо викторины, повтор адреса вслух по карточке, пометки для разбора.

import { csrfToken } from "../shared/api";
import type {
  CallScenario,
  IncidentType,
  OperatorData,
  Questionnaire,
} from "./data";
import type { Address } from "./model";

export interface CallerState {
  readonly panic: number;
  readonly asked: readonly string[];
  readonly facts: readonly string[];
  readonly pauses: number;
  readonly silence_streak: number;
  readonly unheard: number;
  readonly calm_reason: number;
  readonly calm_order: number;
  readonly escalated: boolean;
  readonly escalation_handled: boolean;
  readonly advice: readonly string[];
  /** Адрес подтверждён повтором: заявитель согласился с адресом карточки. */
  readonly confirmed: boolean;
}

/** Начало звонка: паника персонажа из сценария (start_panic). */
export function startState(
  scenario: Pick<CallScenario, "start_panic">,
): CallerState {
  return {
    panic: scenario.start_panic,
    asked: [],
    facts: [],
    pauses: 0,
    silence_streak: 0,
    unheard: 0,
    calm_reason: 0,
    calm_order: 0,
    escalated: false,
    escalation_handled: false,
    advice: [],
    confirmed: false,
  };
}

/**
 * Шаги опроса по стандарту приёма вызова APCO/NENA (questionnaire.schema.json): вкладки
 * над вопросами, по порядку. Номер шага — место в списке плюс один.
 */
export const STEP_TITLES: readonly string[] = [
  "Адрес",
  "Номер для связи",
  "Что случилось",
  "Угроза людям",
  "Детали и доступ",
];

/** Повтор адреса вслух: заявитель отвечает по адресу из карточки. */
export const CONFIRM_KEY = "confirm_address";

/** Ход опроса после ответа заявителя: текущий шаг и пройденные (с сервера). */
export interface Progress {
  readonly step: number;
  readonly done: readonly number[];
}

export const START_PROGRESS: Progress = { step: 1, done: [] };

export interface Line {
  readonly who: "caller" | "operator" | "note";
  readonly text: string;
  /** Голосовой файл реплики заявителя — ключ CALLER_VOICES («сценарий/реплика»). */
  readonly voice?: string;
}

export type Question =
  | { readonly text: string }
  | { readonly questionnaireId: string; readonly key: string }
  | { readonly distractor: string };

export type CalmKind = "reason" | "soft" | "order";

/** Действие оператора — одно обращение к `POST /api/operator/ask`. */
export type Action =
  | { readonly kind: "question"; readonly question: Question }
  | { readonly kind: "calm"; readonly calm: CalmKind }
  | { readonly kind: "hold" }
  | { readonly kind: "silence" }
  | { readonly kind: "advice"; readonly key: string }
  | { readonly kind: "escalate" };

/**
 * Что говорит оператор при «Успокоить». Просьба с причиной (метод повторяющейся
 * настойчивости IAED) просит то, чего не хватает: пока нет адреса — адрес.
 */
export function calmPhrase(kind: CalmKind, state: CallerState): string {
  if (kind === "order") return "Успокойтесь!";
  if (kind === "soft") return "Дышите глубже, я с вами на линии.";
  return state.facts.includes("address")
    ? "Я вам помогу. Отвечайте на мои вопросы — помощь уже едет."
    : "Я вам помогу. Мне нужен адрес, чтобы отправить помощь. Назовите улицу.";
}

export const CALM_OPTIONS: readonly {
  readonly kind: CalmKind;
  readonly hint: string;
}[] = [
  {
    kind: "reason",
    hint: "Просьба с причиной. Не помогло — повторите её подряд.",
  },
  { kind: "soft", hint: "Поддержка без просьбы." },
  { kind: "order", hint: "Приказ без причины." },
];

export const HOLD_PHRASE = "Я вас слышу, записываю.";

/** Запас на чтение и заполнение карточки — по приёмке капитана (этап 4.4). */
export const PAUSE_S = 18;

/** Тон голоса по уровню паники — вместо цифры (разбор 29.09, п. 7). */
export const TONES: readonly string[] = [
  "говорит спокойно",
  "волнуется",
  "паникует, путается",
  "кричит, не слышит вопросов",
];

/**
 * Пора ли ухудшить ситуацию: после вопроса `after_question`, но не раньше `after_s`
 * секунды звонка; самое позднее — на `latest_s`, даже без вопроса.
 */
export function escalationDue(
  scenario: Pick<CallScenario, "escalation">,
  state: CallerState,
  elapsedS: number,
): boolean {
  const escalation = scenario.escalation;
  if (!escalation || state.escalated) return false;
  if (elapsedS >= escalation.latest_s) return true;
  return (
    elapsedS >= escalation.after_s &&
    state.asked.includes(escalation.after_question)
  );
}

/** Карта для подсказок — по группе выбранного типа; у типа без карты подсказок нет. */
export function questionnaireFor(
  data: OperatorData,
  type: IncidentType | undefined,
): Questionnaire | undefined {
  if (!type) return undefined;
  return data.questionnaires.find((card) => card.group_name === type.groupName);
}

/** Вариант вопроса в разговоре: вопрос карты сценария или лишний вопрос шага. */
export interface TalkOption {
  readonly label: string;
  readonly question: Question;
  /** Ключ вопроса карты или лишнего вопроса — чтобы отметить заданный. */
  readonly key: string;
}

function seeded(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], seed: string): T[] {
  const random = seeded(seed);
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

/** Адрес карточки так, как оператор повторяет его вслух: «Дубнинская улица, дом 12, …». */
export function readbackAddress(address: Address): string {
  const parts: [string, string][] = [
    ["", address.street],
    ["дом ", address.house],
    ["корпус ", address.korpus],
    ["квартира ", address.apartment],
  ];
  return parts
    .filter(([, value]) => value.trim())
    .map(([prefix, value]) => prefix + value.trim())
    .join(", ");
}

/**
 * Что говорит оператор при повторе адреса: шаблон карты с адресом карточки. Улицы в
 * карточке ещё нет — просит повторить адрес (заявитель скажет «Я же говорю…»).
 */
export function readbackText(template: string, address: Address): string {
  if (!address.street.trim()) return "Повторите, пожалуйста, адрес.";
  return template.replace("{address}", readbackAddress(address));
}

/** Адрес карточки для сервера: по нему заявитель отвечает на повтор адреса. */
export function readbackBody(address: Address): Record<string, string> {
  return {
    street: address.street,
    house: address.house,
    building: address.korpus,
    apartment: address.apartment,
  };
}

/**
 * Варианты вопросов шага (этап 3, вместо викторины из всех вопросов сразу): вопросы
 * опросной карты этого шага и лишние вопросы того же шага — правдоподобные, но не по делу
 * этого вызова; всего 3–4 (проверяет test_operator_scenarios). Порядок перемешан, но у
 * сценария и шага всегда один и тот же.
 */
export function stepOptions(
  data: OperatorData,
  scenario: CallScenario,
  step: number,
  address: Address,
): TalkOption[] {
  const own = data.questionnaires.find(
    (card) => card.id === scenario.questionnaire_id,
  );
  return shuffle(
    [
      ...(own?.questions ?? [])
        .filter(
          (question) =>
            question.step === step &&
            (question.key !== CONFIRM_KEY || Boolean(address.street.trim())),
        )
        .map((question) => ({
          key: question.key,
          label:
            question.key === CONFIRM_KEY
              ? readbackText(question.text, address)
              : question.text,
          question: { questionnaireId: own!.id, key: question.key },
        })),
      ...scenario.distractors
        .filter((item) => item.step === step)
        .map((item) => ({
          key: item.key,
          label: item.text,
          question: { distractor: item.key },
        })),
    ],
    `${scenario.id}:${step}`,
  );
}

/** Шаг вопроса карты или лишнего вопроса сценария; не нашёлся — шаг 1. */
export function stepOf(
  data: OperatorData,
  scenario: CallScenario,
  key: string,
): number {
  const own = data.questionnaires.find(
    (card) => card.id === scenario.questionnaire_id,
  );
  return (
    own?.questions.find((question) => question.key === key)?.step ??
    scenario.distractors.find((item) => item.key === key)?.step ??
    1
  );
}

/** Первая реплика: звучит сама, когда оператор принял вызов. */
export function firstLines(
  scenario: Pick<CallScenario, "id" | "opening">,
): Line[] {
  return scenario.opening
    ? [
        {
          who: "caller",
          text: scenario.opening,
          voice: `${scenario.id}/opening`,
        },
      ]
    : [];
}

export const ENDED: Readonly<Record<string, string>> = {
  no_contact: "Нет контакта с заявителем, разговор окончен.",
  dropped: "Звонок сорвался, разговор окончен.",
  saved: "Карточка сохранена, разговор окончен.",
};

export const NO_ANSWER = "Нет связи с сервером, задайте вопрос ещё раз.";

function questionBody(question: Question): Record<string, string> {
  if ("text" in question) return { text: question.text };
  if ("distractor" in question) return { distractor: question.distractor };
  return { questionnaire_id: question.questionnaireId, key: question.key };
}

/**
 * Тело `POST /api/operator/ask`. К вопросу — адрес карточки: вдруг это повтор адреса
 * (в режиме «Сложно» свой вопрос узнаётся на сервере).
 */
export function actBody(
  scenarioId: string,
  state: CallerState,
  action: Action,
  address?: Address,
): Record<string, unknown> {
  const base = { scenario_id: scenarioId, state };
  switch (action.kind) {
    case "question":
      return {
        ...base,
        ...questionBody(action.question),
        ...(address ? { address: readbackBody(address) } : {}),
      };
    case "calm":
      return { ...base, action: "calm", kind: action.calm };
    case "advice":
      return { ...base, action: "advice", kind: action.key };
    default:
      return { ...base, action: action.kind };
  }
}

/** Пометка для разбора: помогло, навредило, внимание, событие (app/operator/review.py). */
export interface Mark {
  readonly kind: "good" | "bad" | "warn" | "info";
  readonly text: string;
}

export interface CallerReply {
  readonly outcome: string;
  readonly text: string;
  readonly question_key: string | null;
  readonly variant: "calm" | "panic" | null;
  readonly voice: string | null;
  readonly mark: Mark | null;
}

export interface AskResult {
  readonly state: CallerState;
  readonly reply: CallerReply;
  readonly progress: Progress;
}

export async function act(
  scenarioId: string,
  state: CallerState,
  action: Action,
  address?: Address,
): Promise<AskResult> {
  const response = await fetch("/api/operator/ask", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken(),
    },
    body: JSON.stringify(actBody(scenarioId, state, action, address)),
  });
  if (!response.ok) throw new Error(`ask: ${response.status}`);
  return (await response.json()) as AskResult;
}
