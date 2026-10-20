// Проводник-указатель (DT-07): на каком элементе АРМ стоит подсказка и какой одной
// фразой. Чистые функции без React — шаг берётся из tutorProgress, а уточнения
// (ждёт ли бригада ответа, получен ли доклад) — из учебных данных карточки.
// Полный текст шага остаётся в «Все шаги» полосы проводника.
//
// Подсказка живёт только в обучении («Смотрю», «Вместе»; решение 17.10): во «Вместе» она
// стоит у элемента шага всё время, пока шаг текущий. Пороги «застрял» (stuckAfterS)
// остались от подсказки застрявшему в «Сам» — на тестах её больше нет.
import type { Card } from "../../shared/api";
import { STATE_LABELS } from "../cardModel";
import type { TutorProgress } from "./tutor";

/** Куда указывает подсказка. Цели связи — в колонке зоны 2, они всегда на виду. */
export type PointerTarget =
  | "action"
  | "brigades"
  | "brigade-call"
  | "answer"
  | "hangup";

export interface PointerTip {
  readonly target: PointerTarget;
  readonly text: string;
  /** Идёт разговор: указать на `talkTarget` (по умолчанию «Положить трубку») с этой фразой. */
  readonly talkText?: string;
  /** Цель в окне разговора: «brief» — вводная бригаде («По частям» или её варианты). */
  readonly talkTarget?: "hangup" | "brief";
}

export interface PointerInput {
  readonly progress: TutorProgress;
  readonly state: Card["state"];
  /** Статусы, для которых бригада ещё не доложила (CardTraining.missing_report_states). */
  readonly missingReports: readonly string[];
  /** Бригада звонит сама и ждёт ответа (CardTraining.incoming). */
  readonly incoming: boolean;
}

// Бригада может спросить (DT-10, «живая бригада»): ответ — вариантом в окне разговора.
const LISTEN =
  "Выслушайте бригаду; спросит — ответьте вариантом, затем положите трубку.";

// GP-05: бригада на линии ждёт вводную. Список сил в разговоре скрыт — подсказка уходит к
// ряду ответа (проверка капитана 19.10: она садилась на окно телефона и закрывала «По частям»).
export const BRIEF_TEXT =
  "Дайте вводную голосом или нажмите «По\u00a0частям»: где и что случилось.";

/**
 * Сколько секунд без действий считать «застрял». Бригада на линии ждёт ответа —
 * порог короче: в жизни расчёт сам перезвонит или выйдет в эфир повторно.
 */
export const STUCK_IDLE_S = 15;
export const STUCK_RING_S = 8;
export const stuckAfterS = (tip: PointerTip): number =>
  tip.target === "answer" ? STUCK_RING_S : STUCK_IDLE_S;

/** Фраза ожидания, когда указывать не на что: бригада позвонит сама. */
export const WAIT_TEXT =
  "Бригада позвонит сама — пока можно работать с другими карточками.";

/**
 * Подсказка на текущий шаг. `null` — указывать не на что: упражнение закончено
 * или бригада в пути (тогда полоса говорит WAIT_TEXT).
 */
export function pointerTip(input: PointerInput): PointerTip | null {
  const { progress } = input;
  if (progress.finished) return null;
  if (progress.rejected)
    return {
      target: "action",
      text: "В упражнении происшествие ваше: выберите «Принята» и\u00a0✓.",
    };
  const step = progress.current;
  if (step === "decide")
    return {
      target: "action",
      text: "Выберите «Принята» и коротко в комментарии: что, где, люди. Затем\u00a0✓.",
    };
  // Адрес ДДС не вводит (решение 07.10: в АРМ-112 он у службы только для чтения) —
  // шага «адрес» у подсказки нет.
  if (step === "brigade")
    return {
      target: "brigades",
      text: "Позвоните свободной бригаде и дайте ей вводную по карточке.",
      talkText: BRIEF_TEXT,
      talkTarget: "brief",
    };
  if (
    step === "responding" ||
    step === "arrived" ||
    step === "working" ||
    step === "completed"
  ) {
    if (input.incoming)
      return {
        target: "answer",
        text: "Бригада вызывает — ответьте.",
        talkText: LISTEN,
      };
    if (input.missingReports.includes(step)) {
      // О выезде диспетчер узнаёт сам — звонком бригаде; дальше она звонит сама.
      if (step !== "responding") return null;
      return {
        target: "brigade-call",
        text: "Позвоните направленной бригаде и выслушайте доклад о выезде.",
        talkText: LISTEN,
      };
    }
    const label = STATE_LABELS[step];
    // Номер наряда — номер выехавшей бригады: вписывается с «Начало реагирования», а не на
    // «Принята» — за 30 секунд на решение бригада ещё не выбрана (памятка ДДС, с. 21–22;
    // решение капитана 19.10, docs/decisions.md).
    return {
      target: "action",
      text:
        step === "completed"
          ? `Допишите итог работ в комментарий и выберите «${label}»: карточка закроется.`
          : step === "responding"
            ? `Бригада выехала: выберите «${label}», номер наряда — номер бригады. Затем\u00a0✓.`
            : `Доклад получен: выберите «${label}» и\u00a0✓.`,
      talkText: "Доклад получен. Положите трубку и поставьте статус.",
    };
  }
  return null;
}

/** Все фразы проводника — для проверки, что каждая — одна короткая фраза. */
export function pointerTexts(): string[] {
  const tips: (PointerTip | null)[] = [];
  const steps = [
    "decide",
    "brigade",
    "responding",
    "arrived",
    "working",
    "completed",
  ] as const;
  for (const current of steps)
    for (const flags of [0, 1, 2, 3])
      tips.push(
        pointerTip({
          progress: {
            current,
            missed: [],
            done: new Set(),
            finished: false,
            rejected: false,
          },
          state: "accepted",
          missingReports: flags & 1 ? [current] : [],
          incoming: !!(flags & 2),
        }),
      );
  const texts = new Set<string>([WAIT_TEXT]);
  for (const tip of tips)
    if (tip)
      for (const text of [tip.text, tip.talkText]) if (text) texts.add(text);
  return [...texts];
}

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface PointerPlace {
  readonly left: number;
  readonly top: number;
  /** Где подсказка относительно цели: хвостик смотрит на неё. */
  readonly side: "above" | "below";
  /** Смещение хвостика от левого края подсказки, px. */
  readonly arrow: number;
}

const GAP = 10;
const EDGE = 8;

/**
 * Подсказка — под целью, если помещается, иначе над ней; цель не закрывает.
 * По горизонтали — от левого края цели, но в пределах экрана; хвостик — на цель.
 */
export function placePointer(
  target: Box,
  bubble: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
): PointerPlace {
  const below = target.top + target.height + GAP;
  const above = target.top - bubble.height - GAP;
  const side: PointerPlace["side"] =
    below + bubble.height <= viewport.height - EDGE || above < EDGE
      ? "below"
      : "above";
  const top = Math.max(
    EDGE,
    Math.min(
      side === "below" ? below : above,
      viewport.height - bubble.height - EDGE,
    ),
  );
  const left = Math.min(
    Math.max(EDGE, target.left),
    Math.max(EDGE, viewport.width - bubble.width - EDGE),
  );
  const aim = target.left + Math.min(target.width / 2, 24);
  const arrow = Math.min(
    Math.max(12, aim - left),
    Math.max(12, bubble.width - 24),
  );
  return { left, top, side, arrow };
}
