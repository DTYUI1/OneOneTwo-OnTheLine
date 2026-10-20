// «Как сделал бы опытный» в разборе (макет B: `compareView`, из D): ход опытного рядом
// с ходом обучаемого, строка выделена, где ход разошёлся — опытный сделал, а обучаемый
// нет, или сделал заметно позже. Опытный — карточка, пройденная курсором тренажёра
// (упражнение ступени 1), или эталон сценария, когда повторить карточку нельзя.
import { formatDuration } from "../cardModel";
import { formatPath, statusPath } from "../results/resultsModel";
import type { components } from "../../api-client/schema";

type StoredEvent = components["schemas"]["StoredEvent"];

/** Позже опытного больше чем на столько секунд — ход разошёлся (как в макете). */
const LATE_S = 20;

/** Ход по карточке: время от показа карточки и пройденные статусы. */
export interface Moves {
  /** «Принята» или «Не принята». */
  readonly reaction: number | null;
  readonly dispatched: number | null;
  /** Звонок своей службе окончен. */
  readonly reported: number | null;
  readonly path: string;
  /** Подсказки проводника и «Покажи». */
  readonly helps: number;
}

/** Эталон сценария: что известно об идеальном ходе без повтора карточки. */
export interface Reference {
  readonly reactionNormative: number;
  /** Эталон и факт статусов — из критерия status_flow оценщика; null — его нет. */
  readonly path: string | null;
  readonly fact: string | null;
  /** Статусы совпали с эталоном (балл критерия 1). */
  readonly pathOk: boolean;
  /** Доклад должностному лицу по телефону оценивается. */
  readonly callRequired: boolean;
}

export interface CompareRow {
  readonly title: string;
  readonly pro: string;
  readonly mine: string;
  readonly diff: boolean;
}

export function movesOf(
  events: readonly StoredEvent[],
  deliveredAt: string | null,
  servicePhone: string | null,
): Moves {
  const sorted = [...events].sort(
    (a, b) => Date.parse(a.server_ts) - Date.parse(b.server_ts),
  );
  const start = Date.parse(deliveredAt ?? sorted[0]?.server_ts ?? "");
  const at = (event: StoredEvent | undefined) =>
    event && Number.isFinite(start)
      ? Math.max(0, Math.round((Date.parse(event.server_ts) - start) / 1000))
      : null;
  const payload = (event: StoredEvent) =>
    event.payload as Record<string, unknown>;
  const reaction = sorted.find(
    (event) =>
      event.type === "status_change" &&
      ["accepted", "rejected"].includes(String(payload(event).state)),
  );
  const dialed = new Set(
    sorted
      .filter(
        (event) =>
          event.type === "call_dial" &&
          servicePhone !== null &&
          payload(event).phone_ext === servicePhone,
      )
      .map((event) => String(payload(event).call_id)),
  );
  const reported = sorted.find(
    (event) =>
      (event.type === "call_hangup" || event.type === "call_end") &&
      dialed.has(String(payload(event).call_id)),
  );
  return {
    reaction: at(reaction),
    // Бригаду направляет вводная (GP-05); в журналах до неё — выбор на табло.
    dispatched: at(
      sorted.find(
        (event) =>
          event.type === "brigade_briefing" || event.type === "brigades_select",
      ),
    ),
    reported: at(reported),
    path: formatPath(statusPath(sorted)),
    helps: sorted.filter(
      (event) =>
        event.type === "hint_open" &&
        /^(tutor|show):/.test(String(payload(event).hint_id)),
    ).length,
  };
}

const clock = (seconds: number | null, none: string) =>
  seconds === null ? none : formatDuration(seconds);

const helpText = (helps: number) => {
  if (!helps) return "не понадобилась";
  const tens = helps % 100;
  const ones = helps % 10;
  const word =
    tens >= 11 && tens <= 14 ? "раз" : ones >= 2 && ones <= 4 ? "раза" : "раз";
  return `${helps} ${word}`;
};

/** Сравнение с ходом опытного — карточкой, пройденной курсором тренажёра. */
export function compareWithExpert(mine: Moves, pro: Moves): CompareRow[] {
  const time = (title: string, a: number | null, b: number | null) => ({
    title,
    pro: clock(b, "—"),
    mine: clock(a, "не сделано"),
    diff: b !== null && (a === null || a - b > LATE_S),
  });
  return [
    time("«Принята»", mine.reaction, pro.reaction),
    time("Бригада направлена", mine.dispatched, pro.dispatched),
    {
      title: "Статусы",
      pro: pro.path,
      mine: mine.path,
      diff: pro.path !== mine.path,
    },
    {
      title: "Помощь",
      pro: helpText(pro.helps),
      mine: helpText(mine.helps),
      diff: mine.helps > pro.helps,
    },
  ];
}

/** Сравнение с эталоном сценария, когда карточку курсором не повторить. */
export function compareWithReference(
  mine: Moves,
  reference: Reference,
): CompareRow[] {
  const rows: CompareRow[] = [
    {
      title: "«Принята»",
      pro: `не дольше ${formatDuration(reference.reactionNormative)}`,
      mine: clock(mine.reaction, "не сделано"),
      diff:
        mine.reaction === null || mine.reaction > reference.reactionNormative,
    },
  ];
  // Бригада нужна, если эталон доходит до реагирования (или эталона нет).
  if (reference.path === null || /Начало реагирования/.test(reference.path))
    rows.push({
      title: "Бригада направлена",
      pro: "сразу после «Принята»",
      mine: clock(mine.dispatched, "не направлена"),
      diff: mine.dispatched === null,
    });
  if (reference.callRequired)
    rows.push({
      title: "Доклад своей службе",
      pro: "по памятке ДДС, с. 32",
      mine: clock(mine.reported, "не было"),
      diff: mine.reported === null,
    });
  if (reference.path)
    rows.push({
      title: "Статусы",
      pro: reference.path,
      mine: reference.fact ?? mine.path,
      diff: !reference.pathOk,
    });
  rows.push({
    title: "Помощь",
    pro: helpText(0),
    mine: helpText(mine.helps),
    diff: mine.helps > 0,
  });
  return rows;
}

/** «разошлись в 2 местах» / «ваш ход совпал с опытным». */
export function compareSummary(rows: readonly CompareRow[]): string {
  const n = rows.filter((row) => row.diff).length;
  if (!n) return "ваш ход совпал с опытным";
  const tens = n % 100;
  const ones = n % 10;
  const word = ones === 1 && tens !== 11 ? "месте" : "местах";
  return `разошлись в ${n} ${word}`;
}
