// Чистая state machine софтфона: без React, Web Audio, сети и таймеров.
// Всё внешнее возвращается списком эффектов и исполняется в useSoftphone.
// Так переходы проверяются vitest в node-окружении, без DOM и без мока браузера.

/** Состояния звонка из контракта: `components.schemas.Call.state`. */
export type CallState = "idle" | "dialing" | "ringing" | "talking" | "ended";

/**
 * Подфаза внутри `talking`. Доклад пишется, затем звучит ответная реплика —
 * контракт этого различия не знает, а демо-скрипт §1 п.4 требует.
 */
export type TalkPhase = "reporting" | "closing";

/**
 * Бригада не направлена на это происшествие (28.09): `busy` — занята на другом,
 * `not_assigned` — вызов ей не назначен. Она отвечает отказом и не докладывает.
 */
export type Refusal = "busy" | "not_assigned";

export interface SoftphoneModel {
  readonly state: CallState;
  /** Набранные цифры, не больше EXT_LENGTH. */
  readonly dialed: string;
  readonly callId: string | null;
  readonly phoneExt: string | null;
  readonly phase: TalkPhase | null;
  readonly talkStartedAt: number | null;
  readonly endedAt: number | null;
  /** Звонок оборван до ответа — показываем это как факт, не как ошибку. */
  readonly aborted: boolean;
  /** Входящий: бригада позвонила сама с готовым докладом (27.09). */
  readonly inbound: boolean;
  /** Бригада ответит отказом; `null` — обычный разговор. */
  readonly refusal: Refusal | null;
}

export type SoftphoneEvent =
  | { type: "digit"; digit: string }
  | { type: "backspace" }
  | { type: "clear" }
  /** callId создаётся снаружи, чтобы machine оставался детерминированным. */
  | { type: "dial"; callId: string; at: number; refusal?: Refusal | null }
  /** Ответ на входящий вызов бригады: звонок уже создан сервером (Call.direction=inbound). */
  | { type: "pickup"; callId: string; phoneExt: string; at: number }
  | { type: "ring" }
  | { type: "answer"; at: number }
  | { type: "finish"; at: number }
  | { type: "voice_done"; at: number }
  | { type: "server"; state: CallState; at: number }
  /** Завершение занятия останавливает локальную линию без новых серверных событий. */
  | { type: "suspend"; at: number };

export type Effect =
  | { type: "send"; event: "call_dial" | "call_answer" | "call_hangup" }
  | { type: "tone"; tone: "ringback" | "click" | "stop" }
  | { type: "record"; action: "start" | "stop" }
  | { type: "voice"; phrase: "listen" | "accepted" | Refusal }
  | { type: "wait"; event: "ring" | "answer"; delayMs: number }
  | { type: "upload" };

export interface Step {
  readonly model: SoftphoneModel;
  readonly effects: readonly Effect[];
}

/** Длина внутреннего номера: три цифры (Q&A Q14, `Call.phone_ext` — `^[0-9]{3}$`). */
export const EXT_LENGTH = 3;
/** Щелчок соединения до КПВ — короткая пауза, а не задержка ради реализма. */
export const RING_AFTER_MS = 400;
/**
 * Через сколько абонент снимает трубку. Один цикл КПВ — 5 с; ответ в первой
 * паузе узнаётся на слух и не съедает норматив 180 с на карточку.
 */
export const ANSWER_AFTER_MS = 3500;

export const initialModel: SoftphoneModel = {
  state: "idle",
  dialed: "",
  callId: null,
  phoneExt: null,
  phase: null,
  talkStartedAt: null,
  endedAt: null,
  aborted: false,
  inbound: false,
  refusal: null,
};

function step(model: SoftphoneModel, effects: readonly Effect[] = []): Step {
  return { model, effects };
}

function hangUp(model: SoftphoneModel, at: number, effects: Effect[]): Step {
  return step({ ...model, state: "ended", phase: null, endedAt: at }, [
    ...effects,
    { type: "tone", tone: "stop" },
  ]);
}

export function reduce(model: SoftphoneModel, event: SoftphoneEvent): Step {
  // Сервер может закрыть звонок в любом состоянии; локальная линия ему уступает.
  if (
    event.type === "suspend" ||
    (event.type === "server" && event.state === "ended")
  ) {
    if (model.state === "idle" || model.state === "ended") return step(model);
    const closing: Effect[] = [];
    if (model.state === "talking")
      closing.push({ type: "record", action: "stop" });
    return hangUp(
      { ...model, aborted: model.state !== "talking" },
      event.at,
      closing,
    );
  }

  // Ответ на входящий: сразу разговор, без набора и гудков. Бригада докладывает
  // сама (реплика — из выданного сообщения), «Слушаю» не звучит.
  if (
    event.type === "pickup" &&
    (model.state === "idle" || model.state === "ended")
  )
    return step(
      {
        ...initialModel,
        state: "talking",
        callId: event.callId,
        phoneExt: event.phoneExt,
        phase: "reporting",
        talkStartedAt: event.at,
        inbound: true,
      },
      [
        { type: "tone", tone: "click" },
        { type: "send", event: "call_answer" },
        { type: "record", action: "start" },
      ],
    );

  switch (model.state) {
    case "idle":
      if (event.type === "digit") {
        if (!/^[0-9]$/.test(event.digit)) return step(model);
        // Номер уже набран (например, его не приняли: бригада не направлена) —
        // следующая цифра начинает новый номер. Иначе кнопки «замирали»,
        // пока не сотрёшь три цифры.
        if (model.dialed.length >= EXT_LENGTH)
          return step({ ...model, dialed: event.digit });
        return step({ ...model, dialed: model.dialed + event.digit });
      }
      if (event.type === "backspace")
        return step({ ...model, dialed: model.dialed.slice(0, -1) });
      if (event.type === "clear") return step({ ...model, dialed: "" });
      if (event.type === "dial") {
        if (model.dialed.length !== EXT_LENGTH) return step(model);
        return step(
          {
            ...model,
            state: "dialing",
            callId: event.callId,
            phoneExt: model.dialed,
            aborted: false,
            inbound: false,
            refusal: event.refusal ?? null,
          },
          [
            { type: "send", event: "call_dial" },
            { type: "tone", tone: "click" },
            { type: "wait", event: "ring", delayMs: RING_AFTER_MS },
          ],
        );
      }
      return step(model);

    case "dialing":
      if (event.type === "ring")
        return step({ ...model, state: "ringing" }, [
          { type: "tone", tone: "ringback" },
          { type: "wait", event: "answer", delayMs: ANSWER_AFTER_MS },
        ]);
      if (event.type === "finish")
        return hangUp({ ...model, aborted: true }, event.at, [
          { type: "send", event: "call_hangup" },
        ]);
      return step(model);

    case "ringing":
      // Ненаправленная бригада отвечает отказом сразу и сама кладёт трубку: доклада
      // не будет, записывать нечего, и «информация принята» здесь не звучит.
      if (event.type === "answer" && model.refusal)
        return step(
          {
            ...model,
            state: "talking",
            phase: "closing",
            talkStartedAt: event.at,
          },
          [
            { type: "tone", tone: "stop" },
            { type: "send", event: "call_answer" },
            { type: "voice", phrase: model.refusal },
          ],
        );
      if (event.type === "answer")
        return step(
          {
            ...model,
            state: "talking",
            phase: "reporting",
            talkStartedAt: event.at,
          },
          [
            { type: "tone", tone: "stop" },
            { type: "send", event: "call_answer" },
            { type: "voice", phrase: "listen" },
            { type: "record", action: "start" },
          ],
        );
      if (event.type === "finish")
        return hangUp({ ...model, aborted: true }, event.at, [
          { type: "send", event: "call_hangup" },
        ]);
      return step(model);

    case "talking":
      // Входящий кладём сразу: ответную реплику службы («информация принята»)
      // произносит сторона, которой звонили, — здесь это диспетчер.
      if (event.type === "finish" && model.inbound)
        return hangUp(model, event.at, [
          { type: "record", action: "stop" },
          { type: "tone", tone: "click" },
          { type: "send", event: "call_hangup" },
          { type: "upload" },
        ]);
      // Одна кнопка закрывает доклад: запись стоп, ответная реплика, затем отбой.
      // Отдельное «завершить доклад» перед «положить трубку» — лишнее действие.
      if (event.type === "finish" && model.phase === "reporting")
        return step({ ...model, phase: "closing" }, [
          { type: "record", action: "stop" },
          { type: "voice", phrase: "accepted" },
        ]);
      if (event.type === "voice_done" && model.phase === "closing")
        return hangUp({ ...model }, event.at, [
          { type: "tone", tone: "click" },
          { type: "send", event: "call_hangup" },
          // После отказа записи не было — выгружать нечего.
          ...(model.refusal ? [] : [{ type: "upload" } as const]),
        ]);
      return step(model);

    case "ended":
      // Новый набор сразу после разговора не требует отдельного «сбросить»:
      // цифра или выбор службы в справочнике уже означают новый вызов.
      if (
        event.type === "digit" ||
        event.type === "clear" ||
        event.type === "backspace"
      )
        return reduce(initialModel, event);
      return step(model);

    default:
      return step(model);
  }
}

/** Длительность разговора в миллисекундах; до ответа — ноль. */
export function talkDurationMs(model: SoftphoneModel, now: number): number {
  if (model.talkStartedAt === null) return 0;
  return Math.max(0, (model.endedAt ?? now) - model.talkStartedAt);
}
