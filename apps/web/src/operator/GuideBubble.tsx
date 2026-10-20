// Подсказка проводника первого звонка (этап 3): одна — на следующий шаг, рядом с тем, на
// что указывает, и не закрывает его: цель в разговоре — подсказка над всей панелью
// разговора. Щелчки не перехватывает (pointer-events: none) — кроме кнопки «Скрыть
// проводник». Учебное дополнение: в боевом АРМ 112 его нет.

import { useLayoutEffect, useRef, useState } from "react";
import { placeBubble, type BubblePlace, type GuideTip } from "./guide";
import styles from "./OperatorPage.module.css";

export function GuideBubble({
  tip,
  onHide,
}: {
  tip: GuideTip;
  onHide: () => void;
}) {
  const bubble = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<BubblePlace | null>(null);

  useLayoutEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const target = document.querySelector<HTMLElement>(
          `[data-guide="${tip.target}"]`,
        );
        const own = bubble.current;
        if (!target || !own || !target.getClientRects().length) {
          setPlace(null);
          return;
        }
        const box = target.getBoundingClientRect();
        const talk = target
          .closest<HTMLElement>("[data-help='operator-talk']")
          ?.getBoundingClientRect();
        const next = placeBubble(
          tip.target,
          box,
          { width: own.offsetWidth, height: own.offsetHeight },
          talk ?? null,
          { width: innerWidth, height: innerHeight },
        );
        setPlace((old) =>
          JSON.stringify(old) === JSON.stringify(next) ? old : next,
        );
      });
    };
    // Цель могла уехать за прокрутку правой колонки — показать её (прототип).
    document
      .querySelector<HTMLElement>(`[data-guide="${tip.target}"]`)
      ?.scrollIntoView({ block: "nearest" });
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [tip.target, tip.title]);

  return (
    <div
      ref={bubble}
      role="status"
      aria-label="Проводник"
      className={styles.guide}
      data-side={place?.side ?? "below"}
      style={
        place
          ? {
              left: place.left,
              top: place.top,
              ["--arrow" as string]: `${place.arrow}px`,
            }
          : { visibility: "hidden" }
      }
    >
      <b>Проводник · {tip.title}</b>
      <span>{tip.text}</span>
      <button type="button" onClick={onHide}>
        Скрыть проводник
      </button>
    </div>
  );
}
