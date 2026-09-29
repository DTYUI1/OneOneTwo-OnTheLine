// Сборка занятия по журналу действий: что обучаемый делал, когда и где сбился.
// Чистые функции без React и сети. Оценку здесь не пересчитываем — её считает
// evalcore, мы только показываем, что она сказала.
//
// Порядок — по `server_ts`: он единый для всех рабочих мест. Исходный
// `client_ts` остаётся в событии нетронутым, мы его не переписываем.
//
// Время — общим расчётом C-02 (`shared/timing.ts`) по версии методики занятия,
// как на доске и в оценке. v3 (contracts/I-TIME.md#v3): реакция — от направления
// карточки до первого «Принята» / «Не принята», обработка — от первого открытия
// до терминала, норматив — по активной обработке без подтверждённого ожидания.
// Ожидание знает только сервер: итог попытки (`AttemptAnalysis.timing`) главнее
// своего расчёта, свой — на случай, если разбор недоступен.

import type { components } from "../../api-client/schema";
import { STATE_LABELS } from "../../arm/cardModel";
import { timingInput, type TimingContext } from "../../arm/timingAdapter";
import { lateAnswers, type Callback } from "../../arm/callbacks";
import { calculateTiming } from "../../shared/timing";

export type Card = components["schemas"]["Card"];
export type StoredEvent = components["schemas"]["StoredEvent"];
export type Service = components["schemas"]["Service"];
export type Settings = components["schemas"]["Settings"];
export type TimingResult = components["schemas"]["TimingResult"];
export type InformationEvidence = components["schemas"]["InformationEvidence"];
export type CallTarget = components["schemas"]["CallTarget"];
export type { TimingContext };

/** Обычный шаг работы или место, где обучаемый сбился. */
export type MomentKind = "step" | "problem";

export interface Moment {
  readonly atMs: number;
  /** Секунд от вручения карточки — то, чем меряются нормативы. */
  readonly offsetS: number;
  readonly kind: MomentKind;
  readonly title: string;
  readonly detail: string | null;
}

export type CallPhase = "none" | "dialing" | "talking" | "ended";

/** Состояние карточки на выбранный момент. */
export interface Frame {
  readonly state: Card["state"];
  readonly opened: boolean;
  readonly orderNumber: string;
  readonly comment: string;
  readonly callPhoneExt: string | null;
  readonly callPhase: CallPhase;
  /** Доклады бригад, которые к этой секунде обучаемый уже услышал или прочёл. */
  readonly reports: readonly string[];
}

export interface Timeline {
  readonly startMs: number;
  readonly endMs: number;
  readonly totalS: number;
  readonly moments: readonly Moment[];
  readonly problems: readonly Moment[];
}

// Подписи статусов — общие с АРМ: этапы v3 «Прибытие» и «Проведение работ» тоже.
const STATE_LABEL: Record<string, string> = STATE_LABELS;

const FIELD_LABEL: Record<string, string> = {
  service_number: "Номер наряда",
  comment: "Комментарий",
  address: "Адрес уточнён",
};

/** Подсказки нулевого уровня (FR-1.6) — чем пользовался обучаемый. */
const HINT_LABEL: Record<string, string> = {
  status: "статус",
  number: "номер наряда",
  comment: "комментарий",
  address: "адрес",
  phone: "телефон",
};

const FAILURE_LABEL: Record<string, string> = {
  audio_unavailable: "звукового файла нет",
  playback_error: "сбой воспроизведения",
  interrupted: "прерван",
  session_finished: "занятие завершено",
};

const PRIMARY = new Set(["accepted", "rejected"]);

function text(payload: StoredEvent["payload"], key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

function ms(event: StoredEvent): number {
  return Date.parse(event.server_ts);
}

export function byServerTime(
  events: readonly StoredEvent[],
): readonly StoredEvent[] {
  return [...events].sort((left, right) => ms(left) - ms(right));
}

function addressText(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const address = value as Record<string, unknown>;
  const part = (key: string) =>
    typeof address[key] === "string" ? (address[key] as string) : "";
  const house = [part("house"), part("building")].filter(Boolean).join(" к");
  const apartment = part("apartment") ? `кв. ${part("apartment")}` : "";
  const line = [part("city"), part("street"), house, apartment]
    .filter(Boolean)
    .join(", ");
  return line || null;
}

function title(
  event: StoredEvent,
  input: TimelineInput,
): { title: string; detail: string | null } {
  const payload = event.payload;
  switch (event.type) {
    case "deliver":
      return { title: "Карточка вручена", detail: null };
    case "open":
      return { title: "Карточка открыта", detail: null };
    case "status_change": {
      const state = text(payload, "state");
      return {
        title: `Статус: ${STATE_LABEL[state] ?? state}`,
        detail: text(payload, "comment") || null,
      };
    }
    case "field_change": {
      const field = text(payload, "field");
      return {
        title: FIELD_LABEL[field] ?? field,
        detail:
          field === "address"
            ? addressText(payload.value)
            : text(payload, "value") || null,
      };
    }
    case "comment":
      return { title: "Комментарий", detail: text(payload, "comment") || null };
    case "redirect":
      return {
        title: `Перенаправлена в ${text(payload, "service_id")}`,
        detail: text(payload, "comment") || null,
      };
    case "call_dial":
      return {
        title: `Набран номер ${text(payload, "phone_ext")}`,
        detail: null,
      };
    case "call_dial_target": {
      const target = targetOf(input, text(payload, "call_target_id"));
      return {
        title: target ? `Звонок бригаде ${target.phone_ext}` : "Звонок бригаде",
        detail: target?.name ?? null,
      };
    }
    case "call_answer":
      return { title: "Абонент ответил", detail: null };
    case "call_hangup":
      return { title: "Трубка положена", detail: null };
    case "brigades_select": {
      const ids = payload.brigade_ids;
      return {
        title: `Направлено бригад: ${Array.isArray(ids) ? ids.length : 0}`,
        detail: null,
      };
    }
    case "message_presented":
      return {
        title:
          payload.channel === "text"
            ? "Доклад бригады прочитан"
            : "Доклад бригады прозвучал",
        detail: reportOf(input, text(payload, "delivery_id")),
      };
    case "message_failed": {
      const reason = FAILURE_LABEL[text(payload, "reason")];
      return {
        title: "Доклад бригады не засчитан",
        detail:
          [reason, reportOf(input, text(payload, "delivery_id"))]
            .filter(Boolean)
            .join(": ") || null,
      };
    }
    case "hint_open": {
      const hint = text(payload, "hint_id");
      return {
        title: `Открыта подсказка: ${HINT_LABEL[hint] ?? hint}`,
        detail: null,
      };
    }
    default:
      return { title: event.type, detail: null };
  }
}

function targetOf(input: TimelineInput, id: string): CallTarget | null {
  return input.targets?.find((target) => target.id === id) ?? null;
}

/** Текст доклада по выдаче — то, что обучаемый услышал. */
function reportOf(input: TimelineInput, deliveryId: string): string | null {
  return (
    input.messages?.find((item) => item.delivery.delivery_id === deliveryId)
      ?.delivery.message.text ?? null
  );
}

function seconds(value: number): string {
  return `${Math.round(value)} с`;
}

export interface TimelineInput {
  readonly card: Card;
  readonly events: readonly StoredEvent[];
  readonly services: readonly Service[];
  readonly settings: Settings;
  /** Снимок методики времени занятия; нет — legacy v1 по нормативам `settings`. */
  readonly timing?: TimingContext | null;
  /** Итог сервера по попытке (`AttemptAnalysis.timing`) — с подтверждённым ожиданием. */
  readonly analysis?: TimingResult | null;
  /** Выданные доклады бригад — их текст по `delivery_id`. */
  readonly messages?: readonly InformationEvidence[];
  /** Адресаты звонков бригадам — номер и имя по `call_target_id`. */
  readonly targets?: readonly CallTarget[];
  /** Входящие вызовы бригад (CardTraining.callbacks) — сколько бригада ждала ответа. */
  readonly callbacks?: readonly Callback[];
}

/**
 * Время попытки: итог сервера, если он есть, иначе тот же общий расчёт здесь.
 * `endMs` — граница наблюдения для незавершённой попытки.
 */
export function timingOf(input: TimelineInput, endMs: number): TimingResult {
  if (input.analysis) return input.analysis;
  const context: TimingContext = input.timing ?? {
    sessionId: input.card.session_id,
    policy: null,
    legacyReactionS: input.settings.reaction_normative_s,
    legacyHandlingS: input.settings.handling_normative_s,
  };
  return calculateTiming(
    timingInput(input.card, [...input.events], context, endMs),
  );
}

/**
 * Откуда меряется реакция: с показа строки на АРМ (вручение) во всех версиях —
 * в v3 направление тоже строится из delivered_at (timingAdapter). До вручения
 * карточку никто не видел, поэтому без него — момент выдачи.
 */
function startOf(card: Card): number {
  return Date.parse(card.delivered_at ?? card.appeared_at);
}

/**
 * Места, где обучаемый сбился, выводятся из самого журнала и нормативов —
 * без обращения к оценке: у неё нет отметок времени, а преподавателю нужно
 * попасть в момент, а не в формулировку.
 */
function findProblems(
  input: TimelineInput,
  ordered: readonly StoredEvent[],
  startMs: number,
  endMs: number,
  timing: TimingResult,
): readonly Moment[] {
  const { services } = input;
  const reactionNormS = timing.reaction_normative_s;
  const handlingNormS = timing.handling_normative_s;
  const at = (atMs: number): number => (atMs - startMs) / 1000;
  const mark = (atMs: number, title: string, detail: string): Moment => {
    const clamped = Math.min(atMs, endMs);
    return {
      atMs: clamped,
      offsetS: at(clamped),
      kind: "problem",
      title,
      detail,
    };
  };
  const problems: Moment[] = [];
  const v3 = timing.timing_version === 3;
  const opened = ordered.find((event) => event.type === "open");

  // Реакция. Показ на экране — не штраф: при оценочном качестве времени
  // сервер не выносит превышение, а разбор всё равно показывает, где было поздно.
  const reactionOver =
    timing.reaction_overdue ??
    (timing.reaction_s !== null && timing.reaction_s > reactionNormS);
  if (v3) {
    const primary = ordered.find(
      (event) =>
        event.type === "status_change" &&
        PRIMARY.has(text(event.payload, "state")),
    );
    if (!primary)
      problems.push(
        mark(
          startMs + reactionNormS * 1000,
          "Не было «Принята» / «Не принята»",
          `Норматив реакции — ${seconds(reactionNormS)} от направления карточки до первичного статуса.`,
        ),
      );
    else if (reactionOver && timing.reaction_s !== null)
      problems.push(
        mark(
          ms(primary),
          "Реакция позже норматива",
          `«${STATE_LABEL[text(primary.payload, "state")]}» через ${seconds(timing.reaction_s)} после направления при нормативе ${seconds(reactionNormS)}.`,
        ),
      );
  } else if (!opened) {
    problems.push(
      mark(
        startMs + reactionNormS * 1000,
        "Карточка так и не открыта",
        `Норматив реакции — ${seconds(reactionNormS)}.`,
      ),
    );
  } else if (reactionOver) {
    problems.push(
      mark(
        ms(opened),
        "Реакция позже норматива",
        `Открыл через ${seconds((ms(opened) - startMs) / 1000)} при нормативе ${seconds(reactionNormS)}.`,
      ),
    );
  }

  // Обработка: от ПЕРВОГО открытия до терминала (I-TIME §3, v3 п.2);
  // повторные `open` начало не двигают. Без открытия она не начиналась.
  if (opened) {
    if (timing.handling_s === null) {
      problems.push(
        mark(
          ms(opened) + handlingNormS * 1000,
          "Карточка не закрыта",
          `Норматив обработки — ${seconds(handlingNormS)}.`,
        ),
      );
    } else {
      const doneMs = ms(opened) + timing.handling_s * 1000;
      if (v3) {
        // v3 сравнивает норматив с активной обработкой. Ожидание неизвестно —
        // превышение неизвестно, и ложной ошибки разбор не показывает.
        const active = timing.active_handling_s;
        const over =
          timing.handling_overdue ??
          (active !== null ? active > handlingNormS : null);
        const waiting = timing.waiting_s ?? 0;
        if (over && active !== null)
          problems.push(
            mark(
              doneMs,
              "Обработка дольше норматива",
              waiting > 0
                ? `Активная обработка ${seconds(active)} (из ${seconds(timing.handling_s)} — ожидание сведений ${seconds(waiting)}) при нормативе ${seconds(handlingNormS)}.`
                : `Активная обработка ${seconds(active)} при нормативе ${seconds(handlingNormS)}.`,
            ),
          );
      } else {
        const over =
          timing.handling_overdue ?? timing.handling_s > handlingNormS;
        if (over)
          problems.push(
            mark(
              doneMs,
              "Обработка дольше норматива",
              `Закрыл через ${seconds(timing.handling_s)} после открытия при нормативе ${seconds(handlingNormS)}.`,
            ),
          );
      }
    }
  }

  const ownExtensions = new Set(
    services
      .filter((service) => input.card.source.service_ids.includes(service.id))
      .map((service) => service.phone_ext),
  );
  const dials = ordered.filter((event) => event.type === "call_dial");
  for (const dial of dials) {
    const ext = text(dial.payload, "phone_ext");
    if (ownExtensions.size > 0 && !ownExtensions.has(ext))
      problems.push({
        atMs: ms(dial),
        offsetS: at(ms(dial)),
        kind: "problem",
        title: `Звонок не в службу карточки: ${ext}`,
        detail: `В карточке — ${[...ownExtensions].join(", ")}.`,
      });
  }
  if (dials.length === 0)
    problems.push({
      atMs: endMs,
      offsetS: at(endMs),
      kind: "problem",
      title: "Звонка не было",
      detail: "Доклад должностному лицу не состоялся.",
    });

  // Бригада звонила с докладом, а обучаемый долго не отвечал (27.09): только показ.
  for (const wait of lateAnswers(input.callbacks ?? [], endMs)) {
    const name =
      input.targets?.find((target) => target.brigade_id === wait.brigadeId)
        ?.name ?? "Бригада";
    problems.push(
      mark(
        wait.startedMs,
        "Бригада ждала ответа",
        wait.answered
          ? `${name} позвонила с докладом и ждала ответа ${seconds(wait.waitS)}.`
          : `${name} позвонила с докладом, ответа не было ${seconds(wait.waitS)}.`,
      ),
    );
  }
  return problems.sort((left, right) => left.atMs - right.atMs);
}

export function buildTimeline(input: TimelineInput): Timeline {
  const ordered = byServerTime(input.events);
  const appearedMs = Date.parse(input.card.appeared_at);
  const lastMs =
    ordered.length > 0 ? ms(ordered[ordered.length - 1]) : appearedMs;
  const closedMs = input.card.closed_at
    ? Date.parse(input.card.closed_at)
    : lastMs;
  const observedMs = Math.max(appearedMs, lastMs, closedMs);
  const timing = timingOf(input, observedMs);
  const startMs = startOf(input.card);
  const endMs = Math.max(startMs, observedMs);

  const steps: Moment[] = ordered.map((event) => ({
    atMs: ms(event),
    offsetS: (ms(event) - startMs) / 1000,
    kind: "step",
    ...title(event, input),
  }));
  const problems = findProblems(input, ordered, startMs, endMs, timing);

  return {
    startMs,
    endMs,
    totalS: Math.max(1, (endMs - startMs) / 1000),
    moments: [...steps, ...problems].sort(
      (left, right) => left.atMs - right.atMs,
    ),
    problems,
  };
}

/** Каким было состояние карточки на указанной секунде от вручения. */
export function frameAt(
  input: TimelineInput,
  timeline: Timeline,
  offsetS: number,
): Frame {
  const atMs = timeline.startMs + offsetS * 1000;
  let state: Card["state"] = "added";
  let opened = false;
  let orderNumber = "";
  let comment = "";
  let callPhoneExt: string | null = null;
  let callPhase: CallPhase = "none";
  const reports: string[] = [];

  for (const event of byServerTime(input.events)) {
    if (ms(event) > atMs) break;
    switch (event.type) {
      case "deliver":
        state = "received";
        break;
      case "open":
        opened = true;
        break;
      case "status_change": {
        const next = text(event.payload, "state");
        if (next) state = next as Card["state"];
        const said = text(event.payload, "comment");
        if (said) comment = said;
        break;
      }
      case "redirect":
        state = "redirected";
        break;
      case "field_change": {
        const field = text(event.payload, "field");
        const value = text(event.payload, "value");
        if (field === "service_number") orderNumber = value;
        if (field === "comment") comment = value;
        break;
      }
      case "comment":
        comment = text(event.payload, "comment");
        break;
      case "call_dial":
        callPhoneExt = text(event.payload, "phone_ext");
        callPhase = "dialing";
        break;
      case "call_dial_target":
        callPhoneExt =
          targetOf(input, text(event.payload, "call_target_id"))?.phone_ext ??
          "бригада";
        callPhase = "dialing";
        break;
      case "message_presented": {
        const report = reportOf(input, text(event.payload, "delivery_id"));
        if (report) reports.push(report);
        break;
      }
      case "call_answer":
        callPhase = "talking";
        break;
      case "call_hangup":
        callPhase = "ended";
        break;
      default:
        break;
    }
  }
  return {
    state,
    opened,
    orderNumber,
    comment,
    callPhoneExt,
    callPhase,
    reports,
  };
}

/** Ближайшая ошибка после (или до) текущей секунды — для кнопок перехода. */
export function nextProblem(
  timeline: Timeline,
  offsetS: number,
  direction: 1 | -1,
): Moment | null {
  const ordered =
    direction === 1 ? timeline.problems : [...timeline.problems].reverse();
  return (
    ordered.find((problem) =>
      direction === 1
        ? problem.offsetS > offsetS + 0.5
        : problem.offsetS < offsetS - 0.5,
    ) ?? null
  );
}

export function clock(totalS: number): string {
  const whole = Math.max(0, Math.round(totalS));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
