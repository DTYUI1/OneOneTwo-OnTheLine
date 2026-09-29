// Проводник первого звонка (этап 3): одна подсказка — на следующий шаг, как «Тренировка» у
// диспетчера ДДС и как в прототипе docs/operator_112_review/prototype/. Порядок правил —
// порядок приёма вызова: успокоить, адрес, повтор адреса, номер для связи, тип, угроза,
// детали, отметки опросной карты, описание, «сохранить». Учебное дополнение: в боевом
// АРМ 112 его нет.

import type { CallerState, Progress } from "./dialog";

/** Куда указывает подсказка: элемент экрана с `data-guide`. */
export type GuideTarget =
  | "calm"
  | "hold"
  | "advice"
  | "options"
  | "steps"
  | "street"
  | "type"
  | "card"
  | "description"
  | "save"
  /** Кнопка «Развернуть разговор» свёрнутого окна. */
  | "expand";

export interface GuideTip {
  readonly target: GuideTarget;
  readonly title: string;
  readonly text: string;
}

export interface GuideInput {
  /** Разговор идёт: вызов принят, не закончен и не сохранён. */
  readonly talking: boolean;
  readonly saved: boolean;
  readonly state: CallerState;
  readonly progress: Progress;
  /** Заявитель только что переспросил «Алло?» после паузы — одна подсказка на первую паузу. */
  readonly pauseJustHappened: boolean;
  readonly card: {
    readonly street: string;
    readonly typeChosen: boolean;
    /**
     * Обучаемый выбирает тип: поле в фокусе или в нём что-то введено — под полем открыт
     * список. Подсказка о типе в это время не нужна и закрывала бы список (замечание
     * капитана 29.09).
     */
    readonly selectingType: boolean;
    /** Отмечены все группы опросной карты, от которых зависят службы. */
    readonly tagsAnswered: boolean;
    readonly description: string;
  };
}

/** Цели внутри окна разговора: при свёрнутом окне их не видно. */
const TALK_TARGETS: ReadonlySet<GuideTarget> = new Set([
  "calm",
  "hold",
  "advice",
  "options",
  "steps",
]);

const EXPAND_TIP: GuideTip = {
  target: "expand",
  title: "Разговор свёрнут",
  text: "Разверните его: там вопросы по шагам, «Успокоить», «Советы» и следующая подсказка.",
};

/**
 * Подсказка при свёрнутом разговоре (замечание капитана 29.09: свёрнутое окно глушило
 * проводник целиком). Цель в карточке видна — подсказка остаётся; цель в разговоре скрыта —
 * вместо неё «Разверните разговор».
 */
export function tipForCollapsed(
  tip: GuideTip | null,
  collapsed: boolean,
): GuideTip | null {
  if (!tip || !collapsed) return tip;
  return TALK_TARGETS.has(tip.target) ? EXPAND_TIP : tip;
}

/** Описание короче — вряд ли в нём есть факты, которые ищет оценка. */
export const DESCRIPTION_MIN = 30;

export function nextTip(input: GuideInput): GuideTip | null {
  const { talking, state, progress, card } = input;
  if (input.saved) return null;
  const heard = (key: string) => state.asked.includes(key);
  if (talking) {
    if (state.panic >= 3)
      return {
        target: "calm",
        title: "Заявитель кричит и не слышит вопросов",
        text: "Нажмите «Успокоить» → просьба с причиной. Повторяйте её подряд, пока голос не станет спокойнее.",
      };
    if (state.panic === 2 && state.calm_reason > 0 && !heard("address"))
      return {
        target: "calm",
        title: "Паника ещё высокая",
        text: "Повторите ту же просьбу с причиной — заявитель успокоится и назовёт адрес.",
      };
    if (state.escalated && !state.escalation_handled)
      return {
        target: "advice",
        title: "Ситуация ухудшилась",
        text: "Дайте совет из меню «Советы»: что делать заявителю прямо сейчас.",
      };
    if (input.pauseJustHappened)
      return {
        target: "hold",
        title: "Пауза — это тоже сигнал",
        text: "Молчание пугает: заявителю кажется, что связь пропала. Пока заполняете карточку, говорите «Слышу, записываю».",
      };
    if (!heard("address"))
      return {
        target: "options",
        title: "Шаг 1 — адрес",
        text: "Без адреса помощь не отправить. Выберите вопрос об адресе.",
      };
  }
  if (heard("address") && !card.street.trim())
    return {
      target: "street",
      title: "Внесите адрес в карточку",
      text: "Улица и дом — в поля слева. Записывайте то, что услышали.",
    };
  if (talking && !heard("landmark"))
    return {
      target: "options",
      title: "Спросите ориентир",
      text: "Ориентир — второй способ найти место: магазин, школа, остановка.",
    };
  if (talking && !state.confirmed)
    return {
      target: "options",
      title: "Повторите адрес вслух",
      text: "«Проверю адрес…» — повтор ловит ошибки на слух. Заявитель поправил — исправьте карточку и повторите.",
    };
  if (talking && !progress.done.includes(2))
    return {
      target: "steps",
      title: "Шаг 2 — номер для связи",
      text: "Подтвердите номер: если связь прервётся, вы перезвоните. Спросите имя.",
    };
  if (!card.typeChosen && card.selectingType) return null;
  if (!card.typeChosen)
    return {
      target: "type",
      title: "Выберите тип происшествия",
      text: "Начните вводить, что случилось, и выберите тип из списка.",
    };
  if (talking && !(progress.done.includes(3) && progress.done.includes(4)))
    return {
      target: "steps",
      title: "Шаги 3 и 4",
      text: "Узнайте, что случилось и есть ли угроза людям.",
    };
  // Детали — до отметок: газ, доступ и этаж узнают на шаге 5, а отмечают потом разом.
  if (talking && !progress.done.includes(5))
    return {
      target: "steps",
      title: "Шаг 5 — детали и доступ",
      text: "Подъезд, этаж, доступ — чтобы бригада быстро вошла.",
    };
  if (!card.tagsAnswered)
    return {
      target: "card",
      title: "Отметьте опросную карту",
      text: "Отметьте то, что узнали. От отметок зависят службы на полосе.",
    };
  if (card.description.trim().length < DESCRIPTION_MIN)
    return {
      target: "description",
      title: "Опишите своими словами",
      text: "Что случилось, кто в опасности, доступ, этаж. Оценка ищет факты, а не точные слова.",
    };
  return {
    target: "save",
    title: "Сохраните карточку",
    text: "Нажмите «сохранить» — увидите оценку и разбор звонка по шагам.",
  };
}

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface BubblePlace {
  readonly left: number;
  readonly top: number;
  /** Где стрелка: подсказка над целью (стрелка вниз) или под ней (стрелка вверх). */
  readonly side: "above" | "below";
  /** Сдвиг стрелки от левого края подсказки — к цели. */
  readonly arrow: number;
}

/** Большие части экрана: подсказка встаёт над ними, а не закрывает их снизу. */
const ABOVE: ReadonlySet<GuideTarget> = new Set([
  // Под полем типа — списки групп, найденных и частых типов: подсказка встаёт над полем.
  "type",
  "card",
  "description",
  "save",
]);
const GAP = 12;
const EDGE = 8;

/**
 * Куда поставить подсказку, чтобы она не закрывала то, на что указывает (прототип): цель в
 * панели разговора — над всей панелью (вопросы и кнопки открыты); большие части — над ними;
 * остальное — под целью, а если не влезает — над ней. По ширине — в пределах окна.
 */
export function placeBubble(
  target: GuideTarget,
  box: Box,
  bubble: { readonly width: number; readonly height: number },
  talk: Box | null,
  viewport: { readonly width: number; readonly height: number },
): BubblePlace {
  let top: number;
  let side: BubblePlace["side"];
  if (talk) {
    const above = talk.top - bubble.height - GAP;
    side = above >= EDGE ? "above" : "below";
    top = side === "above" ? above : talk.top + talk.height + GAP;
  } else {
    const above = box.top - bubble.height - GAP;
    const below = box.top + box.height + GAP;
    const fitsBelow = below + bubble.height <= viewport.height - EDGE;
    if ((ABOVE.has(target) && above >= EDGE) || !fitsBelow) {
      top = above;
      side = "above";
    } else {
      top = below;
      side = "below";
    }
  }
  // После увеличения разговора места снаружи может не хватить: подсказка остаётся в экране.
  top = Math.max(EDGE, Math.min(top, viewport.height - bubble.height - EDGE));
  const left = Math.min(
    Math.max(EDGE, box.left + GAP),
    Math.max(EDGE, viewport.width - bubble.width - EDGE),
  );
  const arrow = Math.min(
    Math.max(GAP, box.left + 2 * GAP - left),
    Math.max(GAP, bubble.width - 28),
  );
  return { left, top, side, arrow };
}
