// Перемещаемое окно разговора: перетаскивание за шапку, стрелки, размер за края и
// угол, «−/+», «В центр». Копия operator/useTalkWindow.ts без его localStorage и
// размеров окна 112: место помнится, пока открыта карточка (Softphone с key=card.id).

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  centerPoint,
  clampPoint,
  fitSize,
  MOVE_STEP,
  resizeBox,
  WINDOW_EDGE,
  type Box,
  type Edge,
  type Point,
  type Size,
} from "./callGeometry";

const CORNER: Edge = { x: 1, y: 1 };
/** Ширина свёрнутой полосы: заголовок и время разговора. */
const COLLAPSED_WIDTH = 300;

const ARROWS: Record<string, Point> = {
  ArrowLeft: { left: -MOVE_STEP, top: 0 },
  ArrowRight: { left: MOVE_STEP, top: 0 },
  ArrowUp: { left: 0, top: -MOVE_STEP },
  ArrowDown: { left: 0, top: MOVE_STEP },
};

function viewport(): Size {
  return { width: innerWidth, height: innerHeight };
}

export function useCallWindow(shown: boolean, firstPlace: () => Box) {
  const [collapsed, setCollapsed] = useState(false);
  const preferred = useRef<{ position: Point | null; size: Size | null }>({
    position: null,
    size: null,
  });
  const placeRef = useRef(firstPlace);
  placeRef.current = firstPlace;
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
    origin: Box;
  } | null>(null);

  useLayoutEffect(() => {
    const element = windowRef.current;
    if (!shown || !element) return;
    const measure = () => {
      const screen = viewport();
      // Первое открытие на карточке — место по телефонной полосе, дальше — где оставили.
      if (!preferred.current.position) {
        const first = placeRef.current();
        preferred.current = {
          position: { left: first.left, top: first.top },
          size: preferred.current.size ?? {
            width: first.width,
            height: first.height,
          },
        };
      }
      const size = collapsed
        ? {
            width: Math.min(COLLAPSED_WIDTH, screen.width - WINDOW_EDGE * 2),
            height: element.getBoundingClientRect().height,
          }
        : fitSize(preferred.current.size!, screen);
      const position = clampPoint(preferred.current.position!, size, screen);
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
  }, [shown, collapsed]);

  const moveTo = useCallback((point: Point) => {
    const element = windowRef.current;
    if (!element) return;
    const position = clampPoint(
      point,
      element.getBoundingClientRect(),
      viewport(),
    );
    preferred.current = { ...preferred.current, position };
    setLayout((old) => ({ ...old, ...position }));
  }, []);

  const resizeTo = (origin: Box, edge: Edge, dx: number, dy: number) => {
    if (collapsed) return;
    const next = resizeBox(origin, edge, dx, dy, viewport());
    preferred.current = {
      position: { left: next.left, top: next.top },
      size: { width: next.width, height: next.height },
    };
    setLayout(next);
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
      !target.closest("[data-move-call]")
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
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const stopDrag = (event: PointerEvent<HTMLElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    // Отпустили за окном браузера, а pointerup не пришёл (Firefox) — снимаем захват.
    if (event.buttons === 0) {
      stopDrag(event);
      return;
    }
    const dx = event.clientX - start.x,
      dy = event.clientY - start.y;
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
  };
  const centerWindow = () => {
    const box = windowRef.current?.getBoundingClientRect();
    if (box) moveTo(centerPoint(box, viewport()));
  };
  const toggleCollapsed = () => {
    const box = windowRef.current?.getBoundingClientRect();
    if (box)
      preferred.current = {
        ...preferred.current,
        position: { left: box.left, top: box.top },
      };
    setCollapsed((value) => !value);
  };
  /** Новый звонок начинается с развёрнутого окна: место и размер — прежние. */
  const expand = useCallback(() => setCollapsed(false), []);

  const pointerProps = {
    onPointerMove,
    onPointerUp: stopDrag,
    onPointerCancel: stopDrag,
    onLostPointerCapture: stopDrag,
  };

  return {
    collapsed,
    toggleCollapsed,
    expand,
    windowRef,
    onMoveKey,
    centerWindow,
    style: {
      left: layout.left,
      top: layout.top,
      width: layout.width || undefined,
      height: collapsed ? undefined : layout.height || undefined,
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
    edgeProps: (edge: Edge) => ({
      ...pointerProps,
      onPointerDown: (event: PointerEvent<HTMLSpanElement>) =>
        startDrag(event, "resize", edge),
    }),
  };
}

export type CallWindowView = ReturnType<typeof useCallWindow>;
