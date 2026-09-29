// Таймеры АРМ через общий расчёт C-02 (shared/timing.ts): свою формулу не заводим.
// Адаптер собирает TimingInput из карточки и её событий по правилам I-TIME
// (contracts/I-TIME.md, «Адаптер C-02» и «Направление»), а живое значение
// незавершённой попытки получает тем же расчётом — с условной границей «сейчас».
import type { components } from "../api-client/schema";
import { calculateTiming } from "../shared/timing";
import type { Card } from "../shared/api";

type TimingInput = components["schemas"]["TimingInput"];
type TimingEvent = TimingInput["events"][number];
type TimingPolicy = components["schemas"]["TimingPolicy"];
type TimingResult = components["schemas"]["TimingResult"];
type StoredEvent = components["schemas"]["StoredEvent"];

const LIVE_EVENT_ID = "ffffffff-ffff-4fff-bfff-ffffffffffff";

/**
 * StoredEvent → TimingEvent: deliver/open/redirect — одноимённый kind, status_change —
 * kind=status с его state; прочие действия во временной вход не входят. Для v3 первым
 * идёт направление — kind=direct из серверного delivered_at карточки (event_id = ID
 * карточки, client_ts = server_ts, clock = null). Разрешённых образцов часов у клиента
 * нет, поэтому clock = null: качество живого значения — «оценочное».
 *
 * Почему delivered_at, а не appeared_at: норматив 30 с идёт «с момента появления
 * сообщения в строке состояния» (Q&A Q11). Scheduler выдаёт карточку, даже пока
 * обучаемый ещё входит в систему, — тогда он открывал её с уже набежавшими секундами.
 * Не показанная на АРМ карточка направления не имеет, и отсчёта по ней нет.
 */
export function timingEvents(
  card: Pick<Card, "id" | "delivered_at">,
  events: Pick<
    StoredEvent,
    "id" | "type" | "payload" | "client_ts" | "server_ts"
  >[],
): TimingEvent[] {
  const mapped = events.flatMap((event): TimingEvent[] => {
    const base = {
      event_id: event.id,
      client_ts: event.client_ts,
      server_ts: event.server_ts,
      clock: null,
    };
    if (
      event.type === "deliver" ||
      event.type === "open" ||
      event.type === "redirect"
    )
      return [{ ...base, kind: event.type, state: null }];
    if (event.type === "status_change")
      return [
        {
          ...base,
          kind: "status",
          state: String(event.payload.state) as TimingEvent["state"],
        },
      ];
    return [];
  });
  if (card.delivered_at === null) return mapped;
  const direct: TimingEvent = {
    event_id: card.id,
    kind: "direct",
    state: null,
    client_ts: card.delivered_at,
    server_ts: card.delivered_at,
    clock: null,
  };
  return [direct, ...mapped];
}

export interface TimingContext {
  /** Снимок политики занятия из /sessions/{id}/lifecycle; null — legacy v1. */
  policy: TimingPolicy | null;
  sessionId: string;
  legacyReactionS: number;
  legacyHandlingS: number;
}

/** Что расчёту нужно знать о карточке. */
export type TimedCard = Pick<
  Card,
  "id" | "appeared_at" | "delivered_at" | "interrupted_at"
>;

/**
 * Конец отсчёта незавершённой попытки: «сейчас», но не позже прерывания. Завершение
 * занятия и перезапуск тренировки не закрывают карточку, а прерывают её (C-03), — без
 * этой границы таймер прерванной карточки шёл бы бесконечно («99:59+»).
 */
export function observedAt(card: Pick<Card, "interrupted_at">, now: number) {
  return card.interrupted_at === null
    ? now
    : Math.min(now, Date.parse(card.interrupted_at));
}

export function timingInput(
  card: TimedCard,
  events: Parameters<typeof timingEvents>[1],
  context: TimingContext,
  now: number,
): TimingInput {
  return {
    snapshot_id: context.sessionId,
    policy: context.policy,
    legacy_reaction_normative_s: context.legacyReactionS,
    legacy_handling_normative_s: context.legacyHandlingS,
    appeared_at: card.appeared_at,
    observed_at: new Date(observedAt(card, now)).toISOString(),
    events: timingEvents(card, events),
    // Журнал ожидания учебных сообщений обучаемому не отдаётся — ожидание неизвестно,
    // активное время в АРМ не выдумываем (его считает сервер в разборе попытки).
    waiting: null,
  };
}

export interface LiveTimer {
  seconds: number | null;
  running: boolean;
  normative: number;
  /** Превышение для подсветки на экране (не штраф: штраф — по достоверному времени). */
  over: boolean;
}

export interface LiveTiming {
  version: TimingResult["timing_version"];
  reaction: LiveTimer;
  handling: LiveTimer;
  result: TimingResult;
}

function liveEvent(
  input: TimingInput,
  kind: TimingEvent["kind"],
  state: TimingEvent["state"],
): TimingEvent {
  return {
    event_id: LIVE_EVENT_ID,
    kind,
    state,
    client_ts: input.observed_at,
    server_ts: input.observed_at,
    clock: null,
  };
}

/**
 * Итог по общему расчёту; для ещё идущего отсчёта — тот же расчёт с условным
 * закрывающим событием в момент observed_at (для реакции v3 — первичный статус,
 * v1/v2 — open; для обработки — terminal). Границы и версия — из модуля C-02.
 */
export function liveTiming(input: TimingInput): LiveTiming {
  const result = calculateTiming(input);
  const version = result.timing_version;

  let reactionS = result.reaction_s;
  let reactionRunning = false;
  if (reactionS === null) {
    const probe = calculateTiming({
      ...input,
      events: [
        ...input.events,
        version === 3
          ? liveEvent(input, "status", "accepted")
          : liveEvent(input, "open", null),
      ],
    });
    reactionS = probe.reaction_s;
    reactionRunning = reactionS !== null;
  }

  let handlingS = result.handling_s;
  let handlingRunning = false;
  if (
    handlingS === null &&
    input.events.some((event) => event.kind === "open")
  ) {
    const probe = calculateTiming({
      ...input,
      events: [...input.events, liveEvent(input, "status", "completed")],
    });
    handlingS = probe.handling_s;
    handlingRunning = handlingS !== null;
  }

  return {
    version,
    result,
    reaction: {
      seconds: reactionS,
      running: reactionRunning,
      normative: result.reaction_normative_s,
      over:
        result.reaction_overdue ??
        (reactionS !== null && reactionS > result.reaction_normative_s),
    },
    handling: {
      seconds: handlingS,
      running: handlingRunning,
      normative: result.handling_normative_s,
      over:
        result.handling_overdue ??
        (handlingS !== null && handlingS > result.handling_normative_s),
    },
  };
}

/** Живое время карточки: у прерванной попытки отсчёт остановлен на моменте прерывания. */
export function cardLiveTiming(
  card: TimedCard,
  events: Parameters<typeof timingEvents>[1],
  context: TimingContext,
  now: number,
): LiveTiming {
  const live = liveTiming(timingInput(card, events, context, now));
  if (card.interrupted_at === null) return live;
  return {
    ...live,
    reaction: { ...live.reaction, running: false },
    handling: { ...live.handling, running: false },
  };
}
