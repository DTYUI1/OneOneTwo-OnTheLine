// Общий расчёт учебного времени I-TIME (C-02): legacy v1, v2 и v3 по contracts/I-TIME.md.
// Экраны АРМ, live и replay берут числа отсюда, а не считают свои формулы: один вход
// должен давать одинаковый результат в UI, отчёте и Python-оценщике V-01.
// Проверяется общими примерами contracts/examples/timing-v2.json и timing-v3.json.
import type { TimingCalculator, TimingInput, TimingResult } from "./contracts";

type TimingEvent = TimingInput["events"][number];
type ClockSample = NonNullable<TimingEvent["clock"]>;
type Evidence = TimingResult["evidence"][number];
type Anomaly = TimingResult["anomalies"][number];
type Quality = TimingResult["quality"];
type Policy = NonNullable<TimingInput["policy"]>;

// Порядок перечисления схемы: так же аномалии идут в результате (I-TIME v3, п.7).
const ANOMALY_ORDER: Anomaly[] = [
  "missing_direct",
  "missing_deliver",
  "missing_open",
  "missing_primary_status",
  "missing_terminal",
  "non_monotonic",
  "waiting_unavailable",
  "untrusted_clock",
];
// Допуск проверки формулы midpoint: 1 мс (I-TIME, «Проверяемая синхронизация»).
const OFFSET_FORMULA_TOLERANCE_MS = 1;

const parse = (value: string): number => Date.parse(value);
const iso = (ms: number): string => new Date(ms).toISOString();

interface Normalized {
  at: number;
  evidence: Evidence;
  trusted: boolean;
}

/** Нормализованное время одного события и причина выбора источника. */
function normalize(event: TimingEvent, policy: Policy | null): Normalized {
  const serverAt = parse(event.server_ts);
  const fallback = (reason: Evidence["reason"]): Normalized => ({
    at: serverAt,
    evidence: {
      event_id: event.event_id,
      normalized_at: iso(serverAt),
      source: "server_fallback",
      reason,
    },
    trusted: false,
  });
  if (policy === null) {
    // Legacy v1 сохраняет прежние client_ts без поправки (I-TIME, «Legacy и проверка»).
    const at = parse(event.client_ts);
    return {
      at,
      evidence: {
        event_id: event.event_id,
        normalized_at: iso(at),
        source: "legacy_client",
        reason: "legacy",
      },
      trusted: true,
    };
  }
  if (event.kind === "direct") {
    // Направление фиксирует сервер: часы клиента не участвуют (I-TIME v3).
    return {
      at: serverAt,
      evidence: {
        event_id: event.event_id,
        normalized_at: iso(serverAt),
        source: "server",
        reason: "server_event",
      },
      trusted: true,
    };
  }
  const clock = event.clock;
  if (clock === null) return fallback("missing_clock");
  if (clock.method === "legacy_one_way") return fallback("legacy_clock");
  if (!validSample(clock, policy)) return fallback("invalid_sample");
  const clientAt = parse(event.client_ts);
  const age = clientAt - parse(clock.client_received_at as string);
  if (age < 0 || age > policy.max_sample_age_ms)
    return fallback("stale_sample");
  const at = clientAt + (clock.offset_ms as number);
  if (at > serverAt + policy.future_tolerance_ms)
    return fallback("future_event");
  if (serverAt - at > policy.max_buffer_delay_ms)
    return fallback("buffer_exceeded");
  return {
    at,
    evidence: {
      event_id: event.event_id,
      normalized_at: iso(at),
      source: "corrected_client",
      reason: "verified",
    },
    trusted: true,
  };
}

/** Образец ws_midpoint_v2 пригоден: есть ответ, RTT в пределах и поправка по формуле. */
function validSample(clock: ClockSample, policy: Policy): boolean {
  if (clock.client_received_at === null || clock.offset_ms === null)
    return false;
  const sent = parse(clock.client_sent_at);
  const received = parse(clock.client_received_at);
  const rtt = received - sent;
  if (rtt < 0 || rtt > policy.max_rtt_ms) return false;
  const expected = parse(clock.server_at) - (sent + received) / 2;
  return Math.abs(expected - clock.offset_ms) <= OFFSET_FORMULA_TOLERANCE_MS;
}

/** Длительность в секундах; отрицательная — нарушение хронологии, а не ноль. */
function span(
  start: number | undefined,
  end: number | undefined,
  anomalies: Set<Anomaly>,
): number | null {
  if (start === undefined || end === undefined) return null;
  if (end < start) {
    anomalies.add("non_monotonic");
    return null;
  }
  return (end - start) / 1000;
}

/** Длина объединения интервалов ожидания в границах [from, to] (I-TIME п.5). */
function unionSeconds(
  waiting: NonNullable<TimingInput["waiting"]>,
  from: number,
  to: number,
): number {
  const clipped = waiting
    .map((item) => [
      Math.max(parse(item.started_at), from),
      Math.min(item.ended_at === null ? to : parse(item.ended_at), to),
    ])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cursor = -Infinity;
  for (const [start, end] of clipped) {
    const begin = Math.max(start, cursor);
    if (end > begin) total += end - begin;
    cursor = Math.max(cursor, end);
  }
  return total / 1000;
}

const isStatus = (event: TimingEvent, states: readonly string[]) =>
  event.kind === "status" && states.includes(event.state ?? "");

/** Индекс terminal-события по правилам версии; -1 — попытка не завершена. */
function terminalIndex(events: TimingEvent[], version: 1 | 2 | 3): number {
  const closing =
    version === 1
      ? ["completed", "refused", "rejected"]
      : ["completed", "refused"];
  const first = events.findIndex(
    (event) => event.kind === "redirect" || isStatus(event, closing),
  );
  if (first >= 0 || version !== 3) return first;
  // v3: окончательная «Не принята» без последующей «Принята» завершает обработку.
  let lastPrimary = -1;
  events.forEach((event, index) => {
    if (isStatus(event, ["accepted", "rejected"])) lastPrimary = index;
  });
  return lastPrimary >= 0 && events[lastPrimary].state === "rejected"
    ? lastPrimary
    : -1;
}

/** Расчёт I-TIME: версия выбирается по снимку политики, `policy=null` — legacy v1. */
export const calculateTiming: TimingCalculator = (input) => {
  const policy = input.policy;
  const version: 1 | 2 | 3 = policy === null ? 1 : policy.timing_version;
  const events = input.events;
  const normalized = events.map((event) => normalize(event, policy));
  const at = (index: number) => (index >= 0 ? normalized[index].at : undefined);
  const anomalies = new Set<Anomaly>();

  const reactionStart =
    version === 3
      ? events.findIndex((event) => event.kind === "direct")
      : events.findIndex((event) => event.kind === "deliver");
  const reactionEnd =
    version === 3
      ? events.findIndex((event) => isStatus(event, ["accepted", "rejected"]))
      : events.findIndex((event) => event.kind === "open");
  const open = events.findIndex((event) => event.kind === "open");
  const terminal = terminalIndex(events, version);

  if (reactionStart < 0)
    anomalies.add(version === 3 ? "missing_direct" : "missing_deliver");
  if (open < 0) anomalies.add("missing_open");
  if (version === 3 && reactionEnd < 0) anomalies.add("missing_primary_status");
  if (terminal < 0) anomalies.add("missing_terminal");

  const reaction = span(at(reactionStart), at(reactionEnd), anomalies);
  const handling = span(at(open), at(terminal), anomalies);
  const lifetime = span(parse(input.appeared_at), at(terminal), anomalies);

  let waiting: number | null;
  if (input.waiting === null) {
    anomalies.add("waiting_unavailable");
    waiting = null;
  } else if (open < 0) {
    waiting = input.waiting.length === 0 ? 0 : null;
  } else {
    const end = at(terminal) ?? parse(input.observed_at);
    waiting = unionSeconds(input.waiting, normalized[open].at, end);
  }
  const active =
    handling !== null && waiting !== null ? handling - waiting : null;

  if (normalized.some((item) => !item.trusted))
    anomalies.add("untrusted_clock");
  const quality: Quality =
    version === 1
      ? "legacy"
      : anomalies.has("non_monotonic")
        ? "invalid"
        : anomalies.has("untrusted_clock")
          ? "estimated"
          : "verified";

  const reactionNormative =
    policy === null
      ? input.legacy_reaction_normative_s
      : policy.reaction_normative_s;
  const handlingNormative =
    policy === null
      ? input.legacy_handling_normative_s
      : policy.handling_normative_s;
  // Автоматический штраф — только по достоверному измерению (I-TIME п.7).
  const trusted = quality === "verified" || quality === "legacy";
  const overdue = (value: number | null, normative: number) =>
    trusted && value !== null ? value > normative : null;
  // v3 сравнивает норматив с активной обработкой, v2/v1 — с полной (I-TIME v3, п.6).
  const handlingMeasure = version === 3 ? active : handling;

  return {
    timing_version: version,
    snapshot_id: input.snapshot_id,
    reaction_s: reaction,
    handling_s: handling,
    lifetime_s: lifetime,
    waiting_s: waiting,
    active_handling_s: active,
    reaction_normative_s: reactionNormative,
    handling_normative_s: handlingNormative,
    reaction_overdue: overdue(reaction, reactionNormative),
    handling_overdue: overdue(handlingMeasure, handlingNormative),
    quality,
    anomalies: ANOMALY_ORDER.filter((item) => anomalies.has(item)),
    evidence: normalized.map((item) => item.evidence),
  };
};
