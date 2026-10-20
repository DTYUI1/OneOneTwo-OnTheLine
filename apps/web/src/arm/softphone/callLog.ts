// Лента окна разговора: кто что сказал и что произошло на линии. Чистые функции
// без React: окно только подставляет снимки состояния, решения проверяются тестами.
// Тон деловой: события и реплики, без оценок и эмоций.

import type { BriefingStep } from "./brigade/briefing";
import type { BrigadeQuestion } from "./brigade/logic";
import type { CallState, Refusal } from "./machine";
import { REPORT_PARTS, type ReportPart } from "./report";
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
  /** Засчитанные части сказанного (GP-09, макет телефона): метки ✓/✗ в строке. */
  readonly chips?: readonly Chip[];
}

/** Часть доклада или вводной и прозвучала ли она. */
export interface Chip {
  readonly label: string;
  readonly ok: boolean;
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
  /**
   * Текст прозвучавшей реплики и её ключ (для повтора). `silent` — реплика текстом, без
   * записи (персонаж банка до записей bank-v1, TC-03): прослушать её ещё раз нечего.
   */
  readonly phrase: {
    readonly key: Spoken;
    readonly text: string;
    readonly silent?: boolean;
  } | null;
  readonly voice: string | null;
  readonly report: LineReport | null;
  /**
   * Входящий вызов бригады: первая фраза старшего — кто на связи (TC-01, место банка `intro`).
   * Звучит сразу после ответа, до доклада.
   */
  readonly intro?: string | null;
  /**
   * Разговор снят с удержания (TC-02): первая фраза старшего — он снова на связи (место банка
   * `answer`). Пустая строка — снят с удержания разговор со службой: её «Да, слушаю» приходит
   * обычной репликой (`phrase`). `null` — обычный звонок.
   */
  readonly resumed?: string | null;
  /** Разговор ушёл на удержание: линия свободна, звонок идёт дальше. */
  readonly held?: boolean;
  /** Трубку положил диспетчер (кнопкой), а не абонент. */
  readonly byYou: boolean;
  /** Длительность разговора, «м:сс». */
  readonly duration: string;
  /** Время на часах, «чч:мм:сс». */
  readonly clock: string;
}

/** Чем закончился звонок — одной строкой в ленту. */
export function endNote(s: CallSnapshot): string {
  if (s.held) return `Разговор на удержании, ${s.duration}`;
  if (s.aborted) return "Вызов сброшен";
  if (s.refusal || !s.byYou)
    return `Абонент положил трубку. Разговор ${s.duration}`;
  return `Вы положили трубку. Разговор ${s.duration}`;
}

function note(id: string, text: string): LogLine {
  return { id, who: "note", text };
}

function introLine(s: CallSnapshot): LogLine | null {
  return s.intro && s.state === "talking" && s.resumed == null
    ? { id: "intro", who: "peer", text: s.intro }
    : null;
}

function startLines(s: CallSnapshot): LogLine[] {
  if (s.resumed != null)
    return [
      note("start", `Снят с удержания: ${s.peer}`),
      ...(s.resumed
        ? [{ id: "back", who: "peer", text: s.resumed } satisfies LogLine]
        : []),
    ];
  if (s.inbound)
    return [
      note("start", `Входящий вызов: ${s.peer}`),
      note("connected", `Соединение установлено ${s.clock}`),
    ];
  return [
    note("start", `Вызов: ${s.phoneExt ?? ""} ${s.peer}…`.replace("  ", " ")),
  ];
}

/** Реплика службы (`phrase`) строкой ленты: с повтором звука, если он есть. */
function phraseLine(
  phrase: NonNullable<CallSnapshot["phrase"]>,
  voice: string | null,
): LogLine {
  return {
    id: `phrase-${phrase.key}`,
    who: "peer",
    text: phrase.text,
    ...(phrase.silent
      ? {}
      : {
          replay: {
            kind: "phrase",
            phrase: phrase.key,
            voice,
          } satisfies Replay,
        }),
  };
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
  const sameCall = prev?.callId === next.callId;
  // Снят с удержания тот же звонок, что был в окне (удержали и сразу вернули, в том числе
  // второй раз): сказанное до удержания — сохранёнными строками (`restoredLog`, свои id),
  // «Снят с удержания» и фраза старшего — новыми, и фраза звучит снова (HQ-058).
  const resumedHere =
    sameCall &&
    next.resumed != null &&
    next.state === "talking" &&
    prev?.state !== "talking";
  let out: LogLine[];
  if (!sameCall || resumedHere) {
    out = startLines(next);
    const intro = introLine(next);
    if (intro) out.push(intro);
    // Служба снята с удержания: её «Да, слушаю» звучит в тот же миг, что и снятие.
    if (next.resumed != null && next.phrase)
      out.push(phraseLine(next.phrase, next.voice));
    // Доклад мог прийти на удержании или до первого снимка звонка: он уже звучит
    // и должен попасть в ленту вместе с записью для «Повторите доклад».
    // Своё id у фразы каждого снятия: прежняя уже прозвучала, новая звучит (Softphone).
    if (resumedHere)
      out = restoredLog(
        lines,
        out.map((line) =>
          line.id === "back" ? { ...line, id: `back-${lines.length}` } : line,
        ),
      );
  } else out = [...lines];
  const has = (id: string) => out.some((line) => line.id === id);
  if (
    sameCall &&
    !resumedHere &&
    next.state === "talking" &&
    prev?.state !== "talking" &&
    !has("connected")
  )
    out.push(note("connected", `Соединение установлено ${next.clock}`));
  if (sameCall && next.phrase && next.phrase.key !== prev?.phrase?.key) {
    const line = phraseLine(next.phrase, next.voice);
    if (!has(line.id)) out.push(line);
  }
  const intro = introLine(next);
  if (intro && !has(intro.id)) out.push(intro);
  if (next.report) {
    const report = next.report;
    if (
      !out.some(
        (line) =>
          line.replay?.kind === "report" &&
          line.replay.deliveryId === report.deliveryId,
      )
    )
      out.push({
        id: `report-${report.deliveryId}`,
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
  if (
    next.state === "ended" &&
    (!sameCall || prev?.state !== "ended") &&
    !has("end")
  )
    out.push(note("end", endNote(next)));
  if (sameCall && out.length === lines.length) out = lines as LogLine[];
  return out;
}

/** Строка ленты, сохранённая на удержании (вкладки 17.10): уже прозвучала, повторно не звучит. */
export const HELD_PREFIX = "held-";

/**
 * Лента разговора, снятого с удержания: сказанное до удержания, затем новая часть разговора
 * (`fresh` — «Снят с удержания» и «на связи»). Сохранённые строки получают свои id: прежние
 * «start», «end» и реплики не мешают новым строкам того же звонка.
 */
export function restoredLog(
  saved: readonly LogLine[],
  fresh: readonly LogLine[],
): LogLine[] {
  const delivered = new Set(
    saved.flatMap((line) =>
      line.replay?.kind === "report" ? [line.replay.deliveryId] : [],
    ),
  );
  return [
    ...saved.map((line, index) => ({
      ...line,
      id: line.id.startsWith(HELD_PREFIX)
        ? line.id
        : `${HELD_PREFIX}${index}-${line.id}`,
    })),
    ...fresh.filter(
      (line) =>
        line.replay?.kind !== "report" ||
        !delivered.has(line.replay.deliveryId),
    ),
  ];
}

/** Реплика диспетчера: быстрая фраза или выбранный доклад. */
export function youSaid(
  lines: readonly LogLine[],
  text: string,
  chips?: readonly Chip[],
): LogLine[] {
  return [
    ...lines,
    {
      id: `you-${lines.length}`,
      who: "you",
      text,
      ...(chips ? { chips } : {}),
    },
  ];
}

/** Обязательные части доклада в порядке памятки: услышанные ✓, остальные ✗. */
export function heardChips(
  parts: readonly ReportPart[],
  required: readonly ReportPart[] = REPORT_PARTS.map(({ part }) => part),
): Chip[] {
  const heard = new Set(parts);
  return REPORT_PARTS.filter(({ part }) => required.includes(part)).map(
    ({ part, label }) => ({
      label: label.charAt(0).toUpperCase() + label.slice(1),
      ok: heard.has(part),
    }),
  );
}

/** Реплика диспетчера голосом и в ней — какие части доклада услышаны. */
export function youSaidHeard(
  lines: readonly LogLine[],
  text: string,
  parts: readonly ReportPart[],
  required?: readonly ReportPart[],
): LogLine[] {
  return youSaid(lines, text, heardChips(parts, required));
}

/** Реплика собеседника без записи голоса — уточняющий вопрос службы на доклад. */
export function peerSaid(lines: readonly LogLine[], text: string): LogLine[] {
  return [...lines, { id: `peer-${lines.length}`, who: "peer", text }];
}

export interface QuickPhrase {
  readonly id: "ack" | "repeat" | "reply" | "brief" | "again" | "service-news";
  /** Надпись на кнопке. */
  readonly label: string;
  /** Что диспетчер говорит — строка ленты. */
  readonly text: string;
  /** Снимок просьб и разговора: устаревшая кнопка вести не отправляет событие. */
  readonly serviceNews?: string;
  /** Ответ бригаде вариантом (DT-10): на какую реплику и какой вариант. */
  readonly reply?: { readonly deliveryId: string; readonly optionKey: string };
  /** Часть вводной верна (GP-06): на экране не видна, по ней идёт показ «Смотрю». */
  readonly correct?: boolean;
}

/**
 * Ответы бригаде — только те, за которыми есть реакция: «Принял» — текстовый доклад
 * засчитан, на «Как приняли?» — приём доклада подтверждён (TC-01); «Повторите доклад» —
 * бригада повторяет прозвучавший доклад; вариант ответа на вопрос бригады (DT-10) — бригада
 * отвечает в том же разговоре. Варианты — как их прислал сервер, верный не отмечен. Службе
 * диспетчер докладывает голосом или по частям (report.ts), а не быстрыми фразами; быстрая
 * фраза там одна — «Повторите»: должностное лицо повторяет свою последнюю реплику (TC-03).
 */
export function quickPhrases(input: {
  readonly state: CallState;
  readonly withBrigade: boolean;
  readonly refusal: boolean;
  /** На линии бригада с текстовым докладом, который ещё не засчитан. */
  readonly textReport: boolean;
  /** Озвученный доклад бригады прозвучал и сейчас не звучит — его можно повторить. */
  readonly heardReport: boolean;
  /** Бригада спросила «Как приняли?» и ждёт подтверждения приёма доклада (TC-01). */
  readonly confirm?: boolean;
  /** Вопрос бригады в этом разговоре, на который ещё не ответили. */
  readonly question?: BrigadeQuestion | null;
  /** Шаг вводной по частям (GP-05): бригада ждёт адрес и что случилось. */
  readonly briefing?: BriefingStep | null;
  /** Открытое окно вести по услышанным просьбам о вызванных службах. */
  readonly serviceNews?: string | null;
  /**
   * Последняя реплика должностного лица в докладе службе (TC-03): «Повторите» отдаёт её же.
   * Нет — службе диспетчер только докладывает.
   */
  readonly peerLine?: string | null;
}): readonly QuickPhrase[] {
  if (
    input.state === "talking" &&
    !input.withBrigade &&
    !input.refusal &&
    input.peerLine
  )
    return [{ id: "again", label: "Повторите", text: "Повторите." }];
  if (input.state !== "talking" || input.refusal || !input.withBrigade)
    return [];
  const out: QuickPhrase[] = [];
  if (input.textReport || input.confirm)
    out.push({ id: "ack", label: "Принял", text: "Принял." });
  if (input.heardReport)
    out.push({
      id: "repeat",
      label: "Повторите доклад",
      text: "Повторите доклад.",
    });
  if (input.question)
    for (const option of input.question.options)
      out.push({
        id: "reply",
        label: option.label,
        text: `${option.label}.`,
        reply: {
          deliveryId: input.question.deliveryId,
          optionKey: option.key,
        },
      });
  if (input.serviceNews)
    out.push({
      id: "service-news",
      label: "Служба вызвана",
      text: "Служба вызвана.",
      serviceNews: input.serviceNews,
    });
  if (input.briefing)
    for (const option of input.briefing.options)
      out.push({
        id: "brief",
        label: option.text,
        text: option.text,
        correct: option.correct,
      });
  return out;
}

/**
 * Тексты ленты со своей записью для озвучки (`bankAudiosForText`): доклады бригады и
 * реплика снятой с удержания бригады — повтор её вопроса звучит записью реплики сценария
 * (HQ-058), а не только найденной в сохранённой ленте.
 */
export function knownRecordings(
  lines: readonly LogLine[],
  resumed: { readonly text: string; readonly url: string | null } | null,
): Map<string, string> {
  const known = new Map<string, string>();
  for (const line of lines)
    if (line.replay?.kind === "report" && line.replay.url)
      known.set(line.text, line.replay.url);
  if (resumed?.url) known.set(resumed.text, resumed.url);
  return known;
}
