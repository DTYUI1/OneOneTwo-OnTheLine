// Вкладки линий на плашке звонков окна телефона (проверка 17.10: «надо звонки сделать по
// вкладкам на плашке звонков и добавить удержание звонков»). Вкладка — линия: идущий разговор,
// каждая линия на удержании, каждый входящий вызов (бригады и отдела контроля) и ненадолго —
// линия, где собеседник не дождался на удержании. Щелчок по звонящей вкладке отвечает, по
// удержанной — снимает с удержания; идущий разговор при этом уходит на удержание. Чистые
// функции без React: окно подставляет линии и время, решения проверяет vitest.
import { formatDuration } from "../cardModel";
import {
  heldFor,
  type DroppedLine,
  type HeldLine,
  type LineKind,
} from "./hold";

/** Идущий разговор окна: софтфона открытой карточки или с отделом контроля. */
export interface ActiveLine {
  readonly callId: string;
  readonly cardId: string;
  readonly cardNumber: string | null;
  readonly who: string;
  /** Разговор начался; `null` — ещё набор и гудки. */
  readonly talkStartedAt: number | null;
  /** С кем разговор: у бригады финальной смены — без «по карточке N» (HQ-033). */
  readonly kind?: LineKind;
}

/** Звонящий вызов: бригада или отдел контроля. */
export interface RingingLine {
  readonly callId: string;
  readonly cardId: string;
  readonly cardNumber: string;
  readonly who: string;
  readonly kind: "brigade" | "control";
  readonly alarm: boolean;
  readonly startedAt: number;
}

export type TabAction =
  | {
      readonly type: "answer";
      readonly cardId: string;
      readonly callId: string;
    }
  | {
      readonly type: "answerControl";
      readonly cardId: string;
      readonly callId: string;
    }
  | { readonly type: "resume"; readonly callId: string };

export interface PhoneTab {
  /** Звонок линии (`call_id`). */
  readonly id: string;
  readonly line: "active" | "held" | "ringing" | "dropped";
  readonly who: string;
  /** «говорит 0:42», «на удержании 0:42», «звонит 0:12», «тревога 0:05». */
  readonly state: string;
  /** «по карточке N» — как в прежних строках окна; нет номера — `null`. */
  readonly card: string | null;
  readonly alarm: boolean;
  /** Что делает щелчок; `null` — ничего (идущий разговор, погасшая линия). */
  readonly action: TabAction | null;
}

/** «м:сс». */
function clock(ms: number): string {
  return formatDuration(ms / 1000, { compact: true });
}

/** «Старший бригады · 201» — как строка входящего (TC-01). */
export function brigadeWho(ext: string | null | undefined): string {
  return `Старший бригады${ext ? ` · ${ext}` : ""}`;
}

/** Отдел контроля реагирования — коротко, полное название в подсказке вкладки. */
export const CONTROL_WHO = "Отдел контроля";

function cardOf(number: string | null | undefined): string | null {
  return number ? `по карточке ${number}` : null;
}

/** Собеседник не дождался на удержании — как в макете (docs/dds_training_review/phone):
 * «не дождался … положил трубку» для любой линии, и для службы тоже. */
const DROPPED_STATE = "не дождался, положил трубку";

/**
 * Подпись «по карточке N» у линии бригады; в финальной смене (`settings.final_shift`, HQ-033)
 * её нет: вызов подписан только бригадой, карточку диспетчер находит сам по номеру
 * направленной бригады. `brigadeOnly` — карточки таких смен.
 */
export function brigadeCard(
  cardId: string,
  number: string | null | undefined,
  brigadeOnly: ReadonlySet<string> | undefined,
): string | null {
  return brigadeOnly?.has(cardId) ? null : cardOf(number);
}

/** Вкладки линий: разговор, удержанные, звонящие, погасшие — по одной на звонок. */
export function phoneTabs(input: {
  readonly active: ActiveLine | null;
  readonly held: readonly HeldLine[];
  readonly dropped: readonly DroppedLine[];
  readonly rings: readonly RingingLine[];
  readonly now: number;
  /** Карточки финальной смены: линии бригад — без «по карточке N» (HQ-033). */
  readonly brigadeOnly?: ReadonlySet<string>;
}): PhoneTab[] {
  const { active, held, dropped, rings, now, brigadeOnly } = input;
  const lineCard = (
    kind: LineKind,
    cardId: string,
    number: string | null | undefined,
  ) =>
    kind === "brigade"
      ? brigadeCard(cardId, number, brigadeOnly)
      : cardOf(number);
  const tabs: PhoneTab[] = [];
  const taken = new Set<string>();
  const add = (tab: PhoneTab) => {
    if (taken.has(tab.id)) return;
    taken.add(tab.id);
    tabs.push(tab);
  };
  if (active)
    add({
      id: active.callId,
      line: "active",
      who: active.who,
      state:
        active.talkStartedAt === null
          ? "вызов…"
          : `говорит ${clock(now - active.talkStartedAt)}`,
      card: active.kind
        ? lineCard(active.kind, active.cardId, active.cardNumber)
        : cardOf(active.cardNumber),
      alarm: false,
      action: null,
    });
  for (const line of held)
    add({
      id: line.callId,
      line: "held",
      who: line.who,
      state: `на удержании ${heldFor(line, now)}`,
      card: lineCard(line.kind, line.cardId, line.cardNumber),
      alarm: false,
      action: { type: "resume", callId: line.callId },
    });
  for (const ring of rings)
    add({
      id: ring.callId,
      line: "ringing",
      who: ring.who,
      state: `${ring.alarm ? "тревога" : "звонит"} ${clock(now - ring.startedAt)}`,
      card: lineCard(ring.kind, ring.cardId, ring.cardNumber),
      alarm: ring.alarm,
      action: {
        type: ring.kind === "control" ? "answerControl" : "answer",
        cardId: ring.cardId,
        callId: ring.callId,
      },
    });
  for (const line of dropped)
    add({
      id: line.callId,
      line: "dropped",
      who: line.who,
      state: DROPPED_STATE,
      card: lineCard(line.kind, line.cardId, line.cardNumber),
      alarm: false,
      action: null,
    });
  return tabs;
}

/**
 * Вкладки в порядке появления линий (`order`, см. `lineOrder`): вкладка не прыгает, когда на
 * неё ответили или её удержали, — линия остаётся на своём месте, как кнопка линии на
 * многоканальном аппарате.
 */
export function orderTabs(
  tabs: readonly PhoneTab[],
  order: readonly string[],
): PhoneTab[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return tabs
    .map((tab, index) => ({ tab, index }))
    .sort(
      (a, b) =>
        (rank.get(a.tab.id) ?? Infinity) - (rank.get(b.tab.id) ?? Infinity) ||
        a.index - b.index,
    )
    .map(({ tab }) => tab);
}

/** Сколько линий помнит порядок вкладок — с запасом на смену. */
const ORDER_LIMIT = 50;

/**
 * Порядок вкладок: линии, что уже были, — на прежних местах; новые — в конце, в порядке `ids`.
 * Линия, которой на миг нет (сняли с удержания, а разговор ещё не начался), место не теряет:
 * порядок помнит и погасшие линии (последние ORDER_LIMIT). Тот же массив, если нового нет.
 */
export function lineOrder(
  previous: readonly string[],
  ids: readonly string[],
): readonly string[] {
  const known = new Set(previous);
  const fresh = ids.filter((id) => !known.has(id));
  if (fresh.length === 0) return previous;
  return [...previous, ...fresh].slice(-ORDER_LIMIT);
}
