// Стрелка к кнопке «?» при первом знакомстве (28.09): после приветствия человек
// должен узнать, где объяснение экрана. Подсказка не мешает работе: щелчки проходят
// сквозь неё, в порядок фокуса она не входит и исчезает после первого действия —
// щелчка, Esc или F1. Нет кнопки «?» на экране — подсказка ждёт, пока она появится.
import { useEffect, useLayoutEffect, useState } from "react";
import { acknowledgeHelpTip, hasSeenHelpTip } from "../welcome";
import { useHelpState } from "./HelpProvider";
import styles from "./HelpTip.module.css";

const GAP = 10;
const EDGE = 8;
/** Половина ширины стрелки (HelpTip.module.css: по 10 px с каждой стороны). */
const ARROW_HALF = 10;

interface Place {
  readonly top: number;
  readonly right: number;
  /** Остриё стрелки — над центром кнопки, от правого края подсказки. */
  readonly arrowRight: number;
}

function measure(): Place | null {
  // Поверх открыто окно («Параллельная работа», «Порядок работы») — стрелка под ним
  // не видна, а щелчок по его кнопке погасил бы её непрочитанной. Ждём, пока закроют.
  if (document.querySelector('[aria-modal="true"], dialog[open]')) return null;
  const trigger = document.querySelector<HTMLElement>("[data-help-trigger]");
  if (!trigger || !trigger.getClientRects().length) return null;
  const rect = trigger.getBoundingClientRect();
  const right = Math.max(EDGE, window.innerWidth - rect.right);
  return {
    top: rect.bottom + GAP,
    right,
    arrowRight: Math.max(
      4,
      window.innerWidth - (rect.left + rect.width / 2) - right - ARROW_HALF,
    ),
  };
}

export function HelpTip({ userId }: { userId: string }) {
  const { available, open } = useHelpState();
  const [seen, setSeen] = useState(() => hasSeenHelpTip(userId));
  const [place, setPlace] = useState<Place | null>(null);
  const active = !seen && available && !open;

  // Открыли объяснение — подсказка своё дело сделала.
  useEffect(() => {
    if (open && !seen) {
      acknowledgeHelpTip(userId);
      setSeen(true);
    }
  }, [open, seen, userId]);

  useLayoutEffect(() => {
    if (!active) return;
    const update = () => {
      const next = measure();
      setPlace((prev) =>
        prev &&
        next &&
        prev.top === next.top &&
        prev.right === next.right &&
        prev.arrowRight === next.arrowRight
          ? prev
          : next,
      );
    };
    update();
    // Кнопку «?» могут дорисовать позже без resize/scroll — перемеряем, пока её нет.
    const retry = setInterval(() => {
      if (!document.querySelector("[data-help-trigger]")) return;
      update();
    }, 500);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      clearInterval(retry);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [active]);

  // Закрывать можно только то, что человек видел: пока подсказка не нарисована,
  // щелчок её не «читает» и отметку о показе не ставит.
  const shown = active && place !== null;
  useEffect(() => {
    if (!shown) return;
    const dismiss = () => {
      acknowledgeHelpTip(userId);
      setSeen(true);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "F1") dismiss();
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [shown, userId]);

  if (!active || !place) return null;
  return (
    <div
      role="note"
      aria-label="Подсказка"
      className={styles.tip}
      style={{ top: place.top, right: place.right }}
    >
      <span
        className={styles.arrow}
        style={{ right: place.arrowRight }}
        aria-hidden="true"
      />
      <strong className={styles.title}>Объяснение экрана</strong>
      <span>
        Нажмите «?» — каждая часть экрана получит номер и пояснение. Так проще
        разобраться в интерфейсе.
      </span>
      <span className={styles.note}>
        Подсказка исчезнет после первого щелчка.
      </span>
    </div>
  );
}
