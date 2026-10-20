// Геометрия плавающих окон тренажёра — разговор модуля 112 и телефон ДДС (GP-09): размер
// не зависит от состояния звонка, новый звонок сохраняет место.
export interface Point {
  readonly left: number;
  readonly top: number;
}
export interface Size {
  readonly width: number;
  readonly height: number;
}
export interface WindowPreferences {
  readonly position: Point | null;
  readonly size: Size | null;
  readonly collapsed: boolean;
}

export const WINDOW_EDGE = 8;
export const MOVE_STEP = 20;
export const DEFAULT_WINDOW_SIZE: Size = { width: 760, height: 340 };
const MIN_WINDOW_SIZE: Size = { width: 600, height: 320 };

/**
 * Размер окна по умолчанию и наименьший, до которого его дают сжать. У окна разговора 112
 * и телефона ДДС они разные: в телефоне набор и справочник — вкладки, окно узкое.
 */
export interface WindowLimits {
  readonly initial: Size;
  readonly min: Size;
}

export const WINDOW_LIMITS: WindowLimits = {
  initial: DEFAULT_WINDOW_SIZE,
  min: MIN_WINDOW_SIZE,
};

export function fitWindowSize(
  size: Size,
  viewport: Size,
  position: Point = { left: WINDOW_EDGE, top: WINDOW_EDGE },
  limits: WindowLimits = WINDOW_LIMITS,
): Size {
  return {
    width: Math.min(
      Math.max(limits.min.width, size.width),
      Math.max(0, viewport.width - position.left - WINDOW_EDGE),
    ),
    height: Math.min(
      Math.max(limits.min.height, size.height),
      Math.max(0, viewport.height - position.top - WINDOW_EDGE),
    ),
  };
}

/** Ширина свёрнутого окна разговора 112: видна только шапка. */
export const COLLAPSED_WIDTH = 250;

/**
 * Размер окна на экране. Развёрнутое — сохранённый размер (или по умолчанию) в пределах
 * экрана: содержимое и состояние звонка в расчёт не входят. Свёрнутое — одна шапка
 * высотой `collapsed.head`; телефон ДДС (макет) сохраняет ширину, окно 112 сужается.
 */
export function windowSize(
  preferred: Size | null,
  viewport: Size,
  collapsed: { readonly head: number; readonly keepWidth: boolean } | null,
  limits: WindowLimits = WINDOW_LIMITS,
): Size {
  const open = fitWindowSize(
    preferred ?? limits.initial,
    viewport,
    undefined,
    limits,
  );
  if (!collapsed) return open;
  return {
    width: collapsed.keepWidth
      ? open.width
      : Math.min(COLLAPSED_WIDTH, viewport.width - WINDOW_EDGE * 2),
    height: collapsed.head,
  };
}

/** Край или угол, за который тянут окно: −1 — левый или верхний, 1 — правый или нижний. */
export interface Edge {
  readonly x: -1 | 0 | 1;
  readonly y: -1 | 0 | 1;
}

/**
 * Ручки размера по всем краям и углам (просьба капитана 29.09): раньше размер менялся только
 * за правый нижний угол — это не очевидно.
 */
export const WINDOW_EDGES: readonly {
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
export function resizeWindow(
  origin: Point & Size,
  edge: Edge,
  dx: number,
  dy: number,
  viewport: Size,
  limits: WindowLimits = WINDOW_LIMITS,
): Point & Size {
  const [left, width] = resizeAxis(
    origin.left,
    origin.width,
    dx,
    edge.x,
    limits.min.width,
    viewport.width,
  );
  const [top, height] = resizeAxis(
    origin.top,
    origin.height,
    dy,
    edge.y,
    limits.min.height,
    viewport.height,
  );
  return { left, top, width, height };
}

export function centerPoint(size: Size, viewport: Size): Point {
  return clampWindow(
    {
      left: (viewport.width - size.width) / 2,
      top: (viewport.height - size.height) / 2,
    },
    size,
    viewport,
  );
}

/** Отступы окна от правого и нижнего края экрана (телефон ДДС — над значком). */
export interface Dock {
  readonly right: number;
  readonly bottom: number;
}

/** Место окна, прижатого к правому нижнему углу с отступами `dock`. */
export function dockPoint(size: Size, viewport: Size, dock: Dock): Point {
  return clampWindow(
    {
      left: viewport.width - size.width - dock.right,
      top: viewport.height - size.height - dock.bottom,
    },
    size,
    viewport,
  );
}

export function clampWindow(point: Point, size: Size, viewport: Size): Point {
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

export function loadWindowPreferences(key: string): WindowPreferences {
  const fallback: WindowPreferences = {
    position: null,
    size: null,
    collapsed: false,
  };
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (
      !value ||
      typeof value !== "object" ||
      !("collapsed" in value) ||
      typeof value.collapsed !== "boolean"
    )
      return fallback;
    const position = "position" in value ? value.position : null;
    const size = "size" in value ? value.size : null;
    if (
      size !== null &&
      (typeof size !== "object" ||
        !("width" in size) ||
        !("height" in size) ||
        typeof size.width !== "number" ||
        typeof size.height !== "number" ||
        !Number.isFinite(size.width) ||
        !Number.isFinite(size.height) ||
        size.width <= 0 ||
        size.height <= 0)
    )
      return fallback;
    const savedSize = size as Size | null;
    if (position === null)
      return { position, size: savedSize, collapsed: value.collapsed };
    if (
      typeof position !== "object" ||
      !position ||
      !("left" in position) ||
      !("top" in position) ||
      typeof position.left !== "number" ||
      typeof position.top !== "number" ||
      !Number.isFinite(position.left) ||
      !Number.isFinite(position.top)
    )
      return fallback;
    return {
      position: { left: position.left, top: position.top },
      size: savedSize,
      collapsed: value.collapsed,
    };
  } catch {
    // Повреждённое или недоступное хранилище не мешает принять вызов.
    return fallback;
  }
}

export function saveWindowPreferences(
  key: string,
  value: WindowPreferences,
): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // В приватном окне положение действует до перезагрузки страницы.
  }
}

/** Меню около кнопки: выбираем сторону с местом, длинное меню получает прокрутку. */
export function placeWindowMenu(
  anchor: Point & Size,
  menu: Size,
  viewport: Size,
) {
  const below = viewport.height - anchor.top - anchor.height - WINDOW_EDGE - 4;
  const above = anchor.top - WINDOW_EDGE - 4;
  const down = below >= menu.height || below >= above;
  const maxHeight = Math.max(0, down ? below : above);
  return {
    left: Math.max(
      WINDOW_EDGE,
      Math.min(
        anchor.left + anchor.width - menu.width,
        viewport.width - menu.width - WINDOW_EDGE,
      ),
    ),
    top: down
      ? anchor.top + anchor.height + 4
      : anchor.top - Math.min(menu.height, maxHeight) - 4,
    maxHeight,
  };
}
