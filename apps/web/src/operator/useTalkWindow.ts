import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  clampTalk,
  centerTalk,
  DEFAULT_TALK_SIZE,
  fitTalkSize,
  loadTalkPreferences,
  MOVE_STEP,
  resizeTalk,
  saveTalkPreferences,
  WINDOW_EDGE,
  type Edge,
  type Point,
  type Size,
} from "./talkWindow";

/** Кнопка размера в углу и стрелки тянут правый нижний угол. */
const CORNER: Edge = { x: 1, y: 1 };

const ARROWS: Record<string, Point> = {
  ArrowLeft: { left: -MOVE_STEP, top: 0 },
  ArrowRight: { left: MOVE_STEP, top: 0 },
  ArrowUp: { left: 0, top: -MOVE_STEP },
  ArrowDown: { left: 0, top: MOVE_STEP },
};

/** Сохраняем только предпочтения окна; таймеры, звук и журнал остаются в Talk. */
export function useTalkWindow() {
  const [initial] = useState(loadTalkPreferences);
  // Каждый звонок начинается с развёрнутого разговора (замечание капитана 29.09): свёрнутое
  // с прошлого раза окно прятало вопросы и подсказки проводника. Место и размер — помнятся.
  const [collapsed, setCollapsed] = useState(false);
  const preferred = useRef(initial);
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
  } | null>(null);

  useLayoutEffect(() => {
    const element = windowRef.current;
    if (!element) return;
    const measure = () => {
      const viewport = { width: innerWidth, height: innerHeight };
      const size = collapsed
        ? {
            width: Math.min(250, innerWidth - WINDOW_EDGE * 2),
            height: element.getBoundingClientRect().height,
          }
        : fitTalkSize(preferred.current.size ?? DEFAULT_TALK_SIZE, viewport);
      const position = clampTalk(
        preferred.current.position ?? centerTalk(size, viewport),
        size,
        viewport,
      );
      if (preferred.current.position)
        preferred.current = { ...preferred.current, position };
      saveTalkPreferences({ ...preferred.current, collapsed });
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
  }, [collapsed]);

  const moveTo = useCallback(
    (point: Point) => {
      const element = windowRef.current;
      if (!element) return;
      const position = clampTalk(point, element.getBoundingClientRect(), {
        width: innerWidth,
        height: innerHeight,
      });
      preferred.current = { ...preferred.current, position, collapsed };
      setLayout((old) => ({ ...old, ...position }));
      saveTalkPreferences(preferred.current);
    },
    [collapsed],
  );

  /** Тянут край `edge` окна `origin` на dx, dy; противоположный край остаётся на месте. */
  const resizeTo = (
    origin: Point & Size,
    edge: Edge,
    dx: number,
    dy: number,
  ) => {
    if (collapsed) return;
    const next = resizeTalk(origin, edge, dx, dy, {
      width: innerWidth,
      height: innerHeight,
    });
    const position = { left: next.left, top: next.top };
    const size = { width: next.width, height: next.height };
    preferred.current = { position, size, collapsed };
    setLayout(next);
    saveTalkPreferences(preferred.current);
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
    // При отпускании за окном браузер может не прислать pointerup (Firefox).
    // Снимаем захват при возвращении, иначе следующий щелчок попадёт в заголовок.
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
    if (box)
      moveTo(centerTalk(box, { width: innerWidth, height: innerHeight }));
  };
  const toggleCollapsed = () => {
    const next = !collapsed;
    const box = windowRef.current?.getBoundingClientRect();
    preferred.current = {
      ...preferred.current,
      position: box ? { left: box.left, top: box.top } : null,
      collapsed: next,
    };
    setCollapsed(next);
    saveTalkPreferences(preferred.current);
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
    style: {
      left: layout.left,
      top: layout.top,
      width: layout.width || undefined,
      height: collapsed ? undefined : layout.height || DEFAULT_TALK_SIZE.height,
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
