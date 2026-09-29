// Лента окна разговора: кто что сказал и что произошло на линии. Чистые функции
// без React: окно только подставляет снимки состояния, решения проверяются тестами.
// Тон деловой: события и реплики, без оценок и эмоций.

import type { CallState, Refusal } from "./machine";
import type { Spoken } from "./voices";

/** Что можно прослушать ещё раз: реплику службы или доклад бригады. */
export type Replay =
  | {
      readonly kind: "phrase";
      readonly phrase: Spoken;
      readonly voice: string | null;
    }
  | {
      readonly kind: "report";
      readonly deliveryId: string;
      readonly url: string | null;
      readonly durationMs: number;
    };

export interface LogLine {
  readonly id: string;
  /** `you` — диспетчер, `peer` — служба или бригада, `note` — событие линии. */
  readonly who: "you" | "peer" | "note";
  readonly text: string;
  /** Доклад бригады — крупной строкой: его переносят в карточку. */
  readonly report?: boolean;
  readonly replay?: Replay;
}

/** Доклад бригады на линии. */
export interface LineReport {
  readonly deliveryId: string;
  readonly text: string;
  readonly url: string | null;
  readonly durationMs: number;
}

/** Снимок звонка, по которому дописывается лента. */
export interface CallSnapshot {
  readonly callId: string | null;
  readonly state: CallState;
  readonly inbound: boolean;
  readonly aborted: boolean;
  readonly refusal: Refusal | null;
  readonly phoneExt: string | null;
  /** Кто на линии: название службы или бригады. */
  readonly peer: string;
  /** Текст прозвучавшей реплики и её ключ (для повтора). */
  readonly phrase: { readonly key: Spoken; readonly text: string } | null;
  readonly voice: string | null;
  readonly report: LineReport | null;
  /** Трубку положил диспетчер (кнопкой), а не абонент. */
  readonly byYou: boolean;
  /** Длительность разговора, «м:сс». */
  readonly duration: string;
  /** Время на часах, «чч:мм:сс». */
  readonly clock: string;
}

/** Чем закончился звонок — одной строкой в ленту. */
export function endNote(s: CallSnapshot): string {
  if (s.aborted) return "Вызов сброшен";
  if (s.refusal || !s.byYou)
    return `Абонент положил трубку. Разговор ${s.duration}`;
  return `Вы положили трубку. Разговор ${s.duration}`;
}

function note(id: string, text: string): LogLine {
  return { id, who: "note", text };
}

function startLines(s: CallSnapshot): LogLine[] {
  if (s.inbound)
    return [
      note("start", `Входящий вызов: ${s.peer}`),
      note("connected", `Соединение установлено ${s.clock}`),
    ];
  return [
    note("start", `Вызов: ${s.phoneExt ?? ""} ${s.peer}…`.replace("  ", " ")),
  ];
}

/**
 * Лента после перехода `prev` → `next`. Новый звонок начинает ленту заново:
 * окно одно, и прошлый разговор в нём больше не нужен.
 */
export function advanceLog(
  lines: readonly LogLine[],
  prev: CallSnapshot | null,
  next: CallSnapshot,
): readonly LogLine[] {
  if (!next.callId) return lines;
  if (!prev || prev.callId !== next.callId) {
    const fresh = startLines(next);
    return next.state === "ended"
      ? [...fresh, note("end", endNote(next))]
      : fresh;
  }
  let out = [...lines];
  const has = (id: string) => out.some((line) => line.id === id);
  if (next.state === "talking" && prev.state !== "talking" && !has("connected"))
    out.push(note("connected", `Соединение установлено ${next.clock}`));
  if (next.phrase && next.phrase.key !== prev.phrase?.key) {
    const id = `phrase-${next.phrase.key}`;
    if (!has(id))
      out.push({
        id,
        who: "peer",
        text: next.phrase.text,
        replay: { kind: "phrase", phrase: next.phrase.key, voice: next.voice },
      });
  }
  if (next.report) {
    const id = `report-${next.report.deliveryId}`;
    if (!has(id))
      out.push({
        id,
        who: "peer",
        text: next.report.text,
        report: true,
        replay: {
          kind: "report",
          deliveryId: next.report.deliveryId,
          url: next.report.url,
          durationMs: next.report.durationMs,
        },
      });
  }
  if (next.state === "ended" && prev.state !== "ended" && !has("end"))
    out.push(note("end", endNote(next)));
  if (out.length === lines.length) out = lines as LogLine[];
  return out;
}

/** Реплика диспетчера из быстрой фразы. */
export function youSaid(lines: readonly LogLine[], text: string): LogLine[] {
  return [...lines, { id: `you-${lines.length}`, who: "you", text }];
}

export interface QuickPhrase {
  readonly id: "done" | "ack";
  /** Надпись на кнопке. */
  readonly label: string;
  /** Что диспетчер говорит — строка ленты. */
  readonly text: string;
}

/**
 * Быстрые фразы — только те, за которыми есть реакция: «У меня всё» — служба
 * подтверждает приём и кладёт трубку; «Принял» — текстовый доклад бригады засчитан.
 */
export function quickPhrases(input: {
  readonly state: CallState;
  readonly reporting: boolean;
  readonly inbound: boolean;
  readonly withBrigade: boolean;
  readonly refusal: boolean;
  /** На линии бригада с текстовым докладом, который ещё не засчитан. */
  readonly textReport: boolean;
}): readonly QuickPhrase[] {
  if (input.state !== "talking" || input.refusal) return [];
  const out: QuickPhrase[] = [];
  if (input.withBrigade && input.textReport)
    out.push({ id: "ack", label: "Принял", text: "Принял." });
  if (!input.withBrigade && !input.inbound && input.reporting)
    out.push({ id: "done", label: "У меня всё", text: "У меня всё." });
  return out;
}
