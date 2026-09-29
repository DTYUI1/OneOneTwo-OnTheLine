// Геометрия окна разговора диспетчера. Повторяет окно «Разговор с заявителем»
// модуля 112 (operator/talkWindow.ts), но без localStorage: положение живёт, пока
// открыта карточка, и первое место выбирается по телефонной полосе, а не по центру.

export interface Point {
  readonly left: number;
  readonly top: number;
}
export interface Size {
  readonly width: number;
  readonly height: number;
}
export interface Box extends Point, Size {}

/** Край или угол, за который тянут окно: −1 — левый или верхний, 1 — правый или нижний. */
export interface Edge {
  readonly x: -1 | 0 | 1;
  readonly y: -1 | 0 | 1;
}

export const WINDOW_EDGE = 8;
export const MOVE_STEP = 20;
export const DEFAULT_CALL_SIZE: Size = { width: 400, height: 360 };
export const MIN_CALL_SIZE: Size = { width: 300, height: 220 };
/** Панель телефона: 620 px у правого края карточки с отступом 8 px (Softphone.module.css). */
export const PANEL_SLOT = 620 + 8;

export const CALL_EDGES: readonly {
  readonly name: string;
  readonly edge: Edge;
}[] = [
  { name: "n", edge: { x: 0, y: -1 } },
  { name: "s", edge: { x: 0, y: 1 } },
  { name: "w", edge: { x: -1, y: 0 } },
  { name: "e", edge: { x: 1, y: 0 } },
  { name: "nw", edge: { x: -1, y: -1 } },
  { name: "ne", edge: { x: 1, y: -1 } },
  { name: "sw", edge: { x: -1, y: 1 } },
  { name: "se", edge: { x: 1, y: 1 } },
];

export function clampPoint(point: Point, size: Size, viewport: Size): Point {
  return {
    left: Math.max(
      WINDOW_EDGE,
      Math.min(point.left, viewport.width - size.width - WINDOW_EDGE),
    ),
    top: Math.max(
      WINDOW_EDGE,
      Math.min(point.top, viewport.height - size.height - WINDOW_EDGE),
    ),
  };
}

export function fitSize(size: Size, viewport: Size): Size {
  return {
    width: Math.min(
      Math.max(MIN_CALL_SIZE.width, size.width),
      Math.max(0, viewport.width - WINDOW_EDGE * 2),
    ),
    height: Math.min(
      Math.max(MIN_CALL_SIZE.height, size.height),
      Math.max(0, viewport.height - WINDOW_EDGE * 2),
    ),
  };
}

export function centerPoint(size: Size, viewport: Size): Point {
  return clampPoint(
    {
      left: (viewport.width - size.width) / 2,
      top: (viewport.height - size.height) / 2,
    },
    size,
    viewport,
  );
}

/** Одна ось: тянут дальний край — начало на месте; ближний — на месте противоположный край. */
function resizeAxis(
  start: number,
  length: number,
  delta: number,
  side: -1 | 0 | 1,
  min: number,
  limit: number,
): [number, number] {
  if (side === 0) return [start, length];
  const end = start + length;
  const max = side === 1 ? limit - start - WINDOW_EDGE : end - WINDOW_EDGE;
  const wanted = side === 1 ? length + delta : length - delta;
  const next = Math.max(Math.min(min, max), Math.min(wanted, max));
  return side === 1 ? [start, next] : [end - next, next];
}

/** Окно после того, как его край или угол сдвинули на dx, dy: в экране, не меньше минимума. */
export function resizeBox(
  origin: Box,
  edge: Edge,
  dx: number,
  dy: number,
  viewport: Size,
): Box {
  const [left, width] = resizeAxis(
    origin.left,
    origin.width,
    dx,
    edge.x,
    MIN_CALL_SIZE.width,
    viewport.width,
  );
  const [top, height] = resizeAxis(
    origin.top,
    origin.height,
    dy,
    edge.y,
    MIN_CALL_SIZE.height,
    viewport.height,
  );
  return { left, top, width, height };
}

/**
 * Первое место окна. Оно не закрывает форму статуса и строку служб внизу карточки
 * (`floor`) и панель телефона у правого края: встаёт левее панели, если там хватает
 * места, иначе — у левого края полосы: панель у правого края остаётся открытой
 * для следующего звонка. По высоте — под полосой телефона или над ней, где
 * просторнее (как панель, placement.ts).
 */
export function firstPlace(
  strip: { left: number; right: number; top: number; bottom: number },
  area: { top: number; bottom: number },
  viewport: Size,
  wanted: Size = DEFAULT_CALL_SIZE,
): Box {
  const below = area.bottom - strip.bottom - WINDOW_EDGE * 2;
  const above = strip.top - area.top - WINDOW_EDGE * 2;
  const down = below >= wanted.height || below >= above;
  const room = Math.max(MIN_CALL_SIZE.height, down ? below : above);
  const height = Math.min(wanted.height, room);
  const width = Math.min(wanted.width, viewport.width - WINDOW_EDGE * 2);
  const besidePanel = strip.right - PANEL_SLOT - WINDOW_EDGE - width;
  const left =
    besidePanel >= strip.left + WINDOW_EDGE
      ? besidePanel
      : strip.left + WINDOW_EDGE;
  const top = down
    ? strip.bottom + WINDOW_EDGE
    : strip.top - WINDOW_EDGE - height;
  const size = { width, height };
  return { ...clampPoint({ left, top }, size, viewport), ...size };
}
