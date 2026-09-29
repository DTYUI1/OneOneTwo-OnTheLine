import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { HelpGuide } from "./types";
import { placeMarkers, type Box, type Point } from "./placement";
import styles from "./Help.module.css";

const HelpContext = createContext<{
  register: (guide: HelpGuide | null, onOpen?: () => void) => void;
  guide: HelpGuide | null;
  open: boolean;
  toggle: () => void;
}>({ register: () => {}, guide: null, open: false, toggle: () => {} });

/** Есть ли у экрана объяснение (кнопка «?» в шапке) и открыто ли оно сейчас. */
export function useHelpState(): { available: boolean; open: boolean } {
  const { guide, open } = useContext(HelpContext);
  return { available: guide !== null, open };
}

export function useHelpGuide(guide: HelpGuide | null, onOpen?: () => void) {
  const { register } = useContext(HelpContext);
  const callback = useRef(onOpen);
  callback.current = onOpen;
  useLayoutEffect(() => {
    register(guide, () => callback.current?.());
    return () => register(null);
  }, [guide, register]);
}

export function HelpButton() {
  const { guide, open, toggle } = useContext(HelpContext);
  if (!guide) return null;
  return (
    <button
      type="button"
      className={styles.trigger}
      aria-label="Объяснение экрана"
      data-help-trigger
      aria-expanded={open}
      onClick={toggle}
    >
      ?
    </button>
  );
}

type Part = Box & { key: string; marker?: Point };

/** Отсеиваем скрытые, перекрытые и обрезанные прокруткой части. */
function visibleParts(guide: HelpGuide): Part[] {
  return guide.order.flatMap((key) => {
    const element = document.querySelector<HTMLElement>(`[data-help="${key}"]`);
    if (!element || !element.getClientRects().length) return [];
    const rect = element.getBoundingClientRect();
    let left = Math.max(0, rect.left),
      top = Math.max(0, rect.top);
    let right = Math.min(innerWidth, rect.right),
      bottom = Math.min(innerHeight, rect.bottom);
    for (
      let parent = element.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      const css = getComputedStyle(parent);
      if (css.visibility === "hidden") return [];
      const bounds = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) {
        left = Math.max(left, bounds.left);
        right = Math.min(right, bounds.right);
      }
      if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) {
        top = Math.max(top, bounds.top);
        bottom = Math.min(bottom, bounds.bottom);
      }
    }
    if (right - left < 12 || bottom - top < 12) return [];
    const points = [
      [left + 6, top + 6],
      [(left + right) / 2, (top + bottom) / 2],
      [right - 6, bottom - 6],
    ];
    const exposed = points.some(([x, y]) => {
      const hit = document
        .elementsFromPoint(x, y)
        .find((el) => !el.closest("[data-help-ui]"));
      return hit && (hit === element || element.contains(hit));
    });
    return exposed
      ? [{ key, left, top, width: right - left, height: bottom - top }]
      : [];
  });
}

const CONTROLS = "input, select, textarea, button, img, svg, canvas";

/** Надписи, поля и панель объяснения: номер части не должен их закрывать. */
function obstacles(): Box[] {
  const boxes: Box[] = [];
  const add = (rect: DOMRect, inset = 0) => {
    if (rect.width <= 0 || rect.height <= 0) return;
    if (rect.right < 0 || rect.bottom < 0) return;
    if (rect.left > innerWidth || rect.top > innerHeight) return;
    // Рамку поля номер может немного задеть, её содержимое — нет;
    // отрицательный отступ, наоборот, расширяет занятое место.
    boxes.push({
      left: rect.left + inset,
      top: rect.top + inset,
      width: rect.width - 2 * inset,
      height: rect.height - 2 * inset,
    });
  };
  const range = document.createRange();
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    (node) =>
      node instanceof Element && node.hasAttribute("data-help-ui")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  );
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof Element) {
      if (node.matches(CONTROLS)) add(node.getBoundingClientRect(), 3);
    } else if (node.textContent?.trim()) {
      range.selectNodeContents(node);
      // Зазор, чтобы номер не прилипал к надписи.
      for (const rect of range.getClientRects()) add(rect, -3);
    }
  }
  const panel = document.querySelector("[data-help-ui] [role=region]");
  if (panel) add(panel.getBoundingClientRect(), -4);
  return boxes;
}

function withMarkers(parts: Part[]): Part[] {
  const places = placeMarkers(parts, obstacles(), {
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  });
  return parts.map((part, i) => ({ ...part, marker: places[i] }));
}

function HelpOverlay({
  guide,
  onClose,
}: {
  guide: HelpGuide;
  onClose: () => void;
}) {
  const [parts, setParts] = useState<Part[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const panel = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const topicId = useId();
  const active = parts.find((part) => part.key === selected) ?? parts[0];
  useLayoutEffect(() => {
    // Новое объяснение читается с начала, даже если предыдущее прокрутили до конца.
    // Фокус остаётся на выбранной кнопке перехода.
    if (content.current) content.current.scrollTop = 0;
  }, [active?.key]);
  useLayoutEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    panel.current?.focus();
    return () => {
      // Справку можно читать после прокрутки: возврат фокуса в шапку
      // не должен уводить человека от той части страницы, которую он изучает.
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = withMarkers(visibleParts(guide));
        setParts((old) =>
          JSON.stringify(old) === JSON.stringify(next) ? old : next,
        );
      });
    };
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-help", "hidden"],
    });
    const resize = new ResizeObserver(update);
    document
      .querySelectorAll("[data-help]")
      .forEach((el) => resize.observe(el));
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const hover = (event: PointerEvent) => {
      const region =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-help]")
          : null;
      if (region && guide.topics[region.dataset.help!])
        setSelected(region.dataset.help!);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    // Пока пользователь читает справку, щелчок объясняет часть экрана,
    // а не выполняет действие под ней.
    const explain = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest("[data-help-ui], [data-help-trigger]")) return;
      event.preventDefault();
      event.stopPropagation();
      const region = event.target.closest<HTMLElement>("[data-help]");
      if (region && guide.topics[region.dataset.help!])
        setSelected(region.dataset.help!);
    };
    // При смене текста панель меняет высоту. pointerover возникает и без
    // движения мыши: оказавшаяся под курсором часть сбивала переход «Далее».
    document.addEventListener("pointermove", hover);
    document.addEventListener("keydown", escape, true);
    document.addEventListener("click", explain, true);
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      resize.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      document.removeEventListener("pointermove", hover);
      document.removeEventListener("keydown", escape, true);
      document.removeEventListener("click", explain, true);
    };
  }, [guide, onClose]);
  const index = active ? parts.indexOf(active) : -1;
  const canPrevious = index > 0;
  const canNext = index >= 0 && index < parts.length - 1;
  return (
    <div data-help-ui>
      {parts.map((part, i) => (
        <button
          key={part.key}
          type="button"
          className={styles.marker}
          style={part.marker}
          aria-label={`${i + 1}. ${guide.topics[part.key].title}`}
          aria-pressed={part.key === active?.key}
          onFocus={() => setSelected(part.key)}
          onPointerMove={() => setSelected(part.key)}
          onClick={() => setSelected(part.key)}
        >
          {i + 1}
        </button>
      ))}
      {active && (
        <div
          className={styles.outline}
          style={{
            left: active.left,
            top: active.top,
            width: active.width,
            height: active.height,
          }}
        />
      )}
      <aside
        ref={panel}
        tabIndex={-1}
        className={styles.bubble}
        role="region"
        aria-label={guide.title}
      >
        <div className={styles.heading}>
          <strong>{guide.title}</strong>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть объяснение"
          >
            ✕
          </button>
        </div>
        <div
          ref={content}
          className={styles.content}
          tabIndex={0}
          role="group"
          aria-labelledby={topicId}
          aria-live="polite"
        >
          {active ? (
            <>
              <h2 id={topicId}>
                {index + 1}. {guide.topics[active.key].title}
              </h2>
              <p>{guide.topics[active.key].text}</p>
            </>
          ) : (
            <p id={topicId}>Прокрутите страницу до нужной части.</p>
          )}
        </div>
        <nav aria-label="Переходы по объяснению">
          {/* Нативный disabled сбрасывает фокус при достижении края.
              aria-disabled сохраняет клавиатурный путь; действие блокируем явно. */}
          <button
            type="button"
            aria-disabled={!canPrevious}
            onClick={() => {
              if (canPrevious) setSelected(parts[index - 1].key);
            }}
          >
            Назад
          </button>
          <span>
            {index + 1} из {parts.length}
          </span>
          <button
            type="button"
            aria-disabled={!canNext}
            onClick={() => {
              if (canNext) setSelected(parts[index + 1].key);
            }}
          >
            Далее
          </button>
        </nav>
      </aside>
    </div>
  );
}

export function HelpProvider({ children }: { children: ReactNode }) {
  const [guide, setGuide] = useState<HelpGuide | null>(null);
  const [open, setOpen] = useState(false);
  const onOpen = useRef<(() => void) | undefined>();
  const register = useCallback(
    (next: HelpGuide | null, callback?: () => void) => {
      onOpen.current = callback;
      setGuide(next);
      setOpen(false);
    },
    [],
  );
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => {
    if (!guide) return;
    if (!open) onOpen.current?.();
    setOpen(!open);
  }, [guide, open]);
  useEffect(() => {
    if (!guide) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "F1") return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [guide, toggle]);
  return (
    <HelpContext.Provider
      value={{
        register,
        guide,
        open,
        toggle,
      }}
    >
      {children}
      {open && guide && <HelpOverlay guide={guide} onClose={close} />}
    </HelpContext.Provider>
  );
}
