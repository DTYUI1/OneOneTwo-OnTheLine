import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  clampWindow,
  centerPoint,
  dockPoint,
  loadWindowPreferences,
  MOVE_STEP,
  resizeWindow,
  saveWindowPreferences,
  WINDOW_LIMITS,
  type Dock,
  type Edge,
  type Point,
  type Size,
  type WindowLimits,
  windowSize,
} from "./floatingWindow";

/** Кнопка размера в углу и стрелки тянут правый нижний угол. */
const CORNER: Edge = { x: 1, y: 1 };

const ARROWS: Record<string, Point> = {
  ArrowLeft: { left: -MOVE_STEP, top: 0 },
  ArrowRight: { left: MOVE_STEP, top: 0 },
  ArrowUp: { left: 0, top: -MOVE_STEP },
  ArrowDown: { left: 0, top: MOVE_STEP },
};

/**
 * Сохраняем только предпочтения окна под ключом `storageKey`; таймеры, звук и журнал
 * остаются в самом окне (Talk модуля 112, телефон ДДС).
 */
export function useFloatingWindow(
  storageKey: string,
  {
    collapsedKeepsWidth = false,
    dock,
    limits = WINDOW_LIMITS,
    onResized,
  }: {
    /** Свёрнутое окно той же ширины, только шапка (телефон ДДС, макет). */
    readonly collapsedKeepsWidth?: boolean;
    /**
     * Окно прижато к правому нижнему углу (телефон ДДС, HQ-021): открывается там всегда,
     * сдвинутое возвращается туда при `redock()`; место между открытиями не помнится.
     */
    readonly dock?: Dock;
    /** Размер по умолчанию и наименьший: у телефона ДДС окно уже, чем у разговора 112. */
    readonly limits?: WindowLimits;
    /** Размер изменён: отпущен край или угол, нажата стрелка на кнопке размера. */
    readonly onResized?: () => void;
  } = {},
) {
  const resizedRef = useRef(onResized);
  resizedRef.current = onResized;
  const limitsRef = useRef(limits);
  limitsRef.current = limits;
  const [initial] = useState(() => loadWindowPreferences(storageKey));
  // Каждый звонок начинается с развёрнутого разговора (замечание капитана 29.09): свёрнутое
  // с прошлого раза окно прятало вопросы и подсказки проводника. Место и размер — помнятся.
  const [collapsed, setCollapsed] = useState(false);
  const dockRef = useRef(dock);
  dockRef.current = dock;
  const preferred = useRef(dock ? { ...initial, position: null } : initial);
  // Растёт с каждым redock(): пересчитать место прижатого окна.
  const [docked, setDocked] = useState(0);
  const windowRef = useRef<HTMLElement>(null);
  const [layout, setLayout] = useState({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  });
  const drag = useRef<{
    kind: "move" | "resize";
    edge: Edge;
    id: number;
    x: number;
    y: number;
    origin: Point & Size;
    /** Окно уже тянули: отпускание засчитывается как изменение размера. */
    moved: boolean;
  } | null>(null);

  useLayoutEffect(() => {
    const element = windowRef.current;
    if (!element) return;
    const measure = () => {
      const viewport = { width: innerWidth, height: innerHeight };
      const size = windowSize(
        preferred.current.size,
        viewport,
        collapsed
          ? {
              head: element.getBoundingClientRect().height,
              keepWidth: collapsedKeepsWidth,
            }
          : null,
        limitsRef.current,
      );
      const position = clampWindow(
        preferred.current.position ??
          (dockRef.current
            ? dockPoint(size, viewport, dockRef.current)
            : centerPoint(size, viewport)),
        size,
        viewport,
      );
      if (preferred.current.position)
        preferred.current = { ...preferred.current, position };
      saveWindowPreferences(storageKey, { ...preferred.current, collapsed });
      const next = { ...position, ...size };
      setLayout((old) =>
        old.left === next.left &&
        old.top === next.top &&
        old.width === next.width &&
        old.height === next.height
          ? old
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [collapsed, collapsedKeepsWidth, storageKey, docked]);

  const moveTo = useCallback(
    (point: Point) => {
      const element = windowRef.current;
      if (!element) return;
      const position = clampWindow(point, element.getBoundingClientRect(), {
        width: innerWidth,
        height: innerHeight,
      });
      preferred.current = { ...preferred.current, position, collapsed };
      setLayout((old) => ({ ...old, ...position }));
      saveWindowPreferences(storageKey, preferred.current);
    },
    [collapsed, storageKey],
  );

  /** Тянут край `edge` окна `origin` на dx, dy; противоположный край остаётся на месте. */
  const resizeTo = (
    origin: Point & Size,
    edge: Edge,
    dx: number,
    dy: number,
  ) => {
    if (collapsed) return;
    const next = resizeWindow(
      origin,
      edge,
      dx,
      dy,
      { width: innerWidth, height: innerHeight },
      limitsRef.current,
    );
    const position = { left: next.left, top: next.top };
    const size = { width: next.width, height: next.height };
    preferred.current = { position, size, collapsed };
    setLayout(next);
    saveWindowPreferences(storageKey, preferred.current);
  };

  const startDrag = (
    event: PointerEvent<HTMLElement>,
    kind: "move" | "resize",
    edge: Edge = CORNER,
  ) => {
    if (!event.isPrimary || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (
      kind === "move" &&
      target.closest("button, input, label, a, select, textarea") &&
      !target.closest("[data-move-talk]")
    )
      return;
    const box = windowRef.current?.getBoundingClientRect();
    if (!box) return;
    drag.current = {
      kind,
      edge,
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      origin: {
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
      },
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const stopDrag = (event: PointerEvent<HTMLElement>) => {
    const ended = drag.current;
    if (ended?.id !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (ended.kind === "resize" && ended.moved) resizedRef.current?.();
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    // При отпускании за окном браузер может не прислать pointerup (Firefox).
    // Снимаем захват при возвращении, иначе следующий щелчок попадёт в заголовок.
    if (event.buttons === 0) {
      stopDrag(event);
      return;
    }
    const dx = event.clientX - start.x,
      dy = event.clientY - start.y;
    if (dx || dy) start.moved = true;
    if (start.kind === "resize") resizeTo(start.origin, start.edge, dx, dy);
    else moveTo({ left: start.origin.left + dx, top: start.origin.top + dy });
  };
  const onMoveKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = ARROWS[event.key];
    const box = windowRef.current?.getBoundingClientRect();
    if (!step || !box) return;
    event.preventDefault();
    moveTo({ left: box.left + step.left, top: box.top + step.top });
  };
  const onResizeKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = ARROWS[event.key];
    const box = windowRef.current?.getBoundingClientRect();
    if (!step || !box) return;
    event.preventDefault();
    resizeTo(box, CORNER, step.left, step.top);
    if (!collapsed) resizedRef.current?.();
  };
  const centerWindow = () => {
    const box = windowRef.current?.getBoundingClientRect();
    if (box)
      moveTo(centerPoint(box, { width: innerWidth, height: innerHeight }));
  };
  /** Вернуть прижатое окно в его угол (телефон ДДС — при каждом открытии). */
  const redock = useCallback(() => {
    preferred.current = { ...preferred.current, position: null };
    setDocked((old) => old + 1);
  }, []);
  const toggleCollapsed = () => {
    const next = !collapsed;
    const box = windowRef.current?.getBoundingClientRect();
    // Прижатое окно и свёрнутым остаётся в углу: шапка — у нижнего края.
    const stays = dockRef.current && !preferred.current.position;
    preferred.current = {
      ...preferred.current,
      position: box && !stays ? { left: box.left, top: box.top } : null,
      collapsed: next,
    };
    setCollapsed(next);
    saveWindowPreferences(storageKey, preferred.current);
  };

  const pointerProps = {
    onPointerMove,
    onPointerUp: stopDrag,
    onPointerCancel: stopDrag,
    onLostPointerCapture: stopDrag,
  };

  return {
    collapsed,
    toggleCollapsed,
    windowRef,
    onMoveKey,
    centerWindow,
    redock,
    style: {
      left: layout.left,
      top: layout.top,
      width: layout.width || undefined,
      height: collapsed ? undefined : layout.height || limits.initial.height,
      visibility: layout.width ? ("visible" as const) : ("hidden" as const),
    },
    headerProps: {
      ...pointerProps,
      onPointerDown: (event: PointerEvent<HTMLDivElement>) =>
        startDrag(event, "move"),
    },
    resizeProps: {
      ...pointerProps,
      onPointerDown: (event: PointerEvent<HTMLButtonElement>) =>
        startDrag(event, "resize"),
      onKeyDown: onResizeKey,
    },
    /** Ручка края или угла: тянется мышью, с клавиатуры — кнопка размера в углу. */
    edgeProps: (edge: Edge) => ({
      ...pointerProps,
      onPointerDown: (event: PointerEvent<HTMLSpanElement>) =>
        startDrag(event, "resize", edge),
    }),
  };
}
