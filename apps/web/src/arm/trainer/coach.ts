// Подсказка у элемента (решение 17.10): в обучении тренажёр говорит не постоянной панелью,
// а короткой подсказкой рядом с местом, где идёт действие, — пока шаг текущий. На тестах
// («Сам», ступени 2–4, каталог сценариев, занятия) подсказок нет совсем. Здесь — чистая
// логика: какая подсказка сейчас, что в ней, где ей встать. Вид — TrainerCoach.tsx.
import type { MascotPose } from "../../shared/mascot/mascotModel";
import { isLearning, type CardMode } from "./stages";

/** «Смотрю» (и показ опытного) — подсказка идёт за курсором; «Вместе» — за шагом. */
export type CoachKind = "watch" | "together";

export interface CoachInput {
  /** Личная тренировка обучаемого (занятие преподавателя — всегда тест). */
  readonly practice: boolean;
  readonly mode: CardMode | null;
  readonly closed: boolean;
  /** Показ этой карточки идёт (или сбился, а карточка ещё открыта). */
  readonly demo: boolean;
}

/** Какая подсказка у открытой карточки; null — тест или учить уже нечему. */
export function coachKind(input: CoachInput): CoachKind | null {
  if (!input.practice || !isLearning(input.mode)) return null;
  if (input.demo) return "watch";
  if (input.mode === "together" && !input.closed) return "together";
  return null;
}

/** Части подсказки. Всё, чего нет в списке режима, на экране не появляется. */
export interface CoachParts {
  /** Фраза шага: в «Смотрю» — что делает курсор, во «Вместе» — что сделать. */
  readonly say: boolean;
  /** «Беру управление» и «Пауза». */
  readonly controls: boolean;
  /** «Покажи»: курсор показывает, куда нажать. */
  readonly show: boolean;
  /** Памятка ДДС перед «Не принята», «Отказ», «Работы завершены». */
  readonly check: boolean;
  /** «Услышано по телефону · Подставить» (TC-05). */
  readonly heard: boolean;
  /** «Принята» ждёт 00:03 из 00:30 — три стадии срочности (TC-06). */
  readonly urgency: boolean;
  /** «Возможно, вы имели в виду…» (TC-08). */
  readonly clarity: boolean;
}

const NONE: CoachParts = {
  say: false,
  controls: false,
  show: false,
  check: false,
  heard: false,
  urgency: false,
  clarity: false,
};

export function coachParts(kind: CoachKind | null): CoachParts {
  if (kind === "watch")
    return { ...NONE, say: true, controls: true, check: true };
  if (kind === "together")
    return {
      say: true,
      controls: false,
      show: true,
      check: true,
      heard: true,
      urgency: true,
      clarity: true,
    };
  return NONE;
}

/** К чему подсказка встаёт: строка статуса, элемент шага или элемент под курсором показа. */
export type CoachAnchor = "line" | "step" | "cursor";

/**
 * Проверка, «Услышано по телефону» и понятность комментария — про строку статуса, поэтому
 * подсказка с ними — у строки. Иначе «Вместе» — у элемента шага, «Смотрю» — у курсора.
 */
export function coachAnchor(
  kind: CoachKind,
  aids: {
    readonly check: boolean;
    readonly heard: boolean;
    readonly clarity: boolean;
  },
): CoachAnchor {
  if (aids.check) return "line";
  if (kind === "watch") return "cursor";
  return aids.heard || aids.clarity ? "line" : "step";
}

// ---------------------------------------------------------------- наставник

/** Что наставник делает в подсказке; «point» — указывает ручкой туда же, куда стрелка. */
export type CoachGesture =
  | "point"
  | "explain"
  | "listen"
  | "attention"
  | "correct"
  | "wait";

/**
 * Жест по тому, что в подсказке (библия маскота, раздел 5). Проверка перед необратимым
 * статусом — объясняет памятку; «Принята» на исходе норматива — «обратите внимание»; в
 * упражнении поставили «Не принята» — спокойно поправляет; идёт разговор с бригадой —
 * слушает; показ на паузе — ждёт. Иначе указывает на место шага.
 */
export function coachGesture(aids: {
  readonly check: boolean;
  readonly urgent: boolean;
  readonly correcting: boolean;
  readonly talking: boolean;
  readonly paused: boolean;
}): CoachGesture {
  if (aids.check) return "explain";
  if (aids.urgent) return "attention";
  if (aids.correcting) return "correct";
  if (aids.talking) return "listen";
  if (aids.paused) return "wait";
  return "point";
}

/** Поза по жесту: указывает — куда рука (poseToward по положению цели), иначе — сам жест. */
export function coachPose(
  gesture: CoachGesture,
  pointing: MascotPose,
): MascotPose {
  return gesture === "point" ? pointing : gesture;
}

/**
 * Наставник стоит у края подсказки, ближнего к цели: справа, когда подсказка слева от цели;
 * над или под целью — у того края, где хвостик (цель у правого края экрана — значок
 * телефона — хвостик справа). Отражать фигуру нельзя: гарнитура по канону на левом ухе.
 */
export function mentorOnRight(
  place: Pick<CoachPlace, "side" | "arrow">,
  width: number,
): boolean {
  if (place.side === "left") return true;
  if (place.side === "right") return false;
  return place.arrow > width / 2;
}

/**
 * Фигура наставника рядом с облаком: место 150 × 150, фигура у верхнего края, плечо — на
 * трети высоты (TrainerCoach.module.css, Tour.module.css).
 */
export const MENTOR = { width: 150, height: 150, shoulder: 52 } as const;

/**
 * От плеча наставника к центру цели: фигура стоит у левого или правого края подсказки
 * (mentorOnRight), сверху. По этому направлению выбирается поза (poseToward).
 */
export function mentorAim(
  place: Pick<CoachPlace, "left" | "top">,
  size: { readonly width: number; readonly height: number },
  target: Box,
  right: boolean,
): { readonly dx: number; readonly dy: number } {
  const x = right
    ? place.left + size.width - MENTOR.width / 2
    : place.left + MENTOR.width / 2;
  const y = place.top + MENTOR.shoulder;
  return {
    dx: target.left + target.width / 2 - x,
    dy: target.top + target.height / 2 - y,
  };
}

// ---------------------------------------------------------------- место на экране

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export type CoachSide = "above" | "below" | "left" | "right";

export interface CoachPlace {
  readonly left: number;
  readonly top: number;
  /** Где подсказка относительно цели: хвостик смотрит на неё. */
  readonly side: CoachSide;
  /** Смещение хвостика вдоль стороны, обращённой к цели, px. */
  readonly arrow: number;
}

const GAP = 12;
const EDGE = 8;
const ARROW_EDGE = 16;
const SIDES: readonly CoachSide[] = ["above", "below", "right", "left"];
/**
 * Цель внутри высокого препятствия (окно телефона): сбоку от него хвостик достаёт до неё
 * напрямую. Внутри плоского (строка статуса) — над ним или под ним, ближе к самой цели.
 */
const SIDES_INSIDE: readonly CoachSide[] = ["left", "right", "above", "below"];

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

function overlaps(a: Box, b: Box): boolean {
  return (
    a.left < b.left + b.width &&
    b.left < a.left + a.width &&
    a.top < b.top + b.height &&
    b.top < a.top + a.height
  );
}

function holds(box: Box, x: number, y: number): boolean {
  return (
    x >= box.left &&
    x <= box.left + box.width &&
    y >= box.top &&
    y <= box.top + box.height
  );
}

/** Положения вдоль стороны: сначала желаемое, остальные — по удалённости от него. */
function nearestFirst(preferred: number, others: readonly number[]): number[] {
  return [preferred, ...others].sort(
    (a, b) => Math.abs(a - preferred) - Math.abs(b - preferred),
  );
}

/**
 * Место подсказки: рядом с целью, не на ней и не на препятствиях (окно телефона, строка
 * статуса с её заметками). Цель внутри препятствия — кнопка в окне телефона — подсказка
 * встаёт сбоку от препятствия, хвостик — на цель. Порядок: над, под, справа, слева; если
 * мешает препятствие — сдвиг вдоль стороны на ближайшее свободное место. Места нет —
 * препятствия уступаются с конца списка: первое (окно телефона) подсказка закрывает только
 * тогда, когда иначе встала бы на цель (проверка капитана 19.10, 1280×720: она закрывала
 * «По частям»).
 */
export function placeCoach(
  target: Box,
  size: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
  obstacles: readonly Box[] = [],
): CoachPlace {
  const cx = target.left + target.width / 2;
  const cy = target.top + target.height / 2;
  const host = obstacles.find((box) => holds(box, cx, cy)) ?? null;
  const around = host ?? target;
  const { width, height } = size;
  const maxLeft = viewport.width - width - EDGE;
  const maxTop = viewport.height - height - EDGE;

  const candidates: CoachPlace[] = [];
  const beside = host !== null && host.height > height;
  for (const side of beside ? SIDES_INSIDE : SIDES) {
    const vertical = side === "above" || side === "below";
    if (vertical) {
      const top =
        side === "above"
          ? around.top - height - GAP
          : around.top + around.height + GAP;
      if (top < EDGE || top > maxTop) continue;
      const lefts = nearestFirst(
        clamp(cx - ARROW_EDGE * 2, EDGE, maxLeft),
        obstacles.flatMap((box) =>
          [box.left - width - GAP, box.left + box.width + GAP].map((raw) =>
            clamp(raw, EDGE, maxLeft),
          ),
        ),
      );
      for (const left of lefts) {
        candidates.push({
          left,
          top,
          side,
          arrow: clamp(cx - left, ARROW_EDGE, width - ARROW_EDGE),
        });
      }
    } else {
      const left =
        side === "right"
          ? around.left + around.width + GAP
          : around.left - width - GAP;
      if (left < EDGE || left > maxLeft) continue;
      const tops = nearestFirst(
        clamp(cy - ARROW_EDGE * 2, EDGE, maxTop),
        obstacles.flatMap((box) =>
          [box.top - height - GAP, box.top + box.height + GAP].map((raw) =>
            clamp(raw, EDGE, maxTop),
          ),
        ),
      );
      for (const top of tops) {
        candidates.push({
          left,
          top,
          side,
          arrow: clamp(cy - top, ARROW_EDGE, height - ARROW_EDGE),
        });
      }
    }
  }
  const boxOf = (place: CoachPlace): Box => ({
    left: place.left,
    top: place.top,
    width,
    height,
  });
  for (let keep = obstacles.length; keep >= 0; keep--) {
    const avoid = [target, ...obstacles.slice(0, keep)];
    const free = candidates.find(
      (place) => !avoid.some((box) => overlaps(boxOf(place), box)),
    );
    if (free) return free;
  }
  // Экран меньше подсказки: под целью, в пределах экрана.
  const left = clamp(cx - ARROW_EDGE * 2, EDGE, maxLeft);
  return {
    left,
    top: clamp(target.top + target.height + GAP, EDGE, maxTop),
    side: "below",
    arrow: clamp(cx - left, ARROW_EDGE, width - ARROW_EDGE),
  };
}
