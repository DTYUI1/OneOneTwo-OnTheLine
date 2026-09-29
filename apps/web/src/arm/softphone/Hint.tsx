// Кнопка «?» с коротким пояснением (подсказки «нулевого уровня», FR-1.6).
// Открывается нажатием, а не наведением: наведение пропадает, стоит сдвинуть
// мышь. Закрывается повторным нажатием, Esc или щелчком мимо. Текст живёт в
// области role="status", поэтому экранный диктор его прочитает.

import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { limits, placePanel, watchLayout } from "./placement";
import styles from "./Hint.module.css";

export function Hint({
  label,
  align = "left",
  onOpen,
  children,
}: {
  /** Что поясняется — для экранного диктора: «Подсказка: телефон». */
  label: string;
  /** С какого края кнопки выравнивать окно. */
  align?: "left" | "right";
  /** Открытие подсказки — учебное событие `hint_open`, как у подсказок карточки. */
  onOpen?: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const id = useId();

  // Окно раскрывается туда, где есть место, по тому же правилу, что панель.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!open || !root) return;
    const fit = () =>
      setUp(placePanel(root.getBoundingClientRect(), limits(root)).up);
    fit();
    return watchLayout(root, fit);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <span
      ref={rootRef}
      className={[
        styles.hint,
        up ? styles.up : "",
        align === "right" ? styles.right : "",
      ].join(" ")}
    >
      <button
        type="button"
        className={styles.button}
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen(!open);
        }}
      >
        ?
      </button>
      <span id={id} role="status">
        {open && <span className={styles.bubble}>{children}</span>}
      </span>
    </span>
  );
}
