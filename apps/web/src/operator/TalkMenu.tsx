import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { placeTalkMenu, type Point } from "./talkWindow";
import styles from "./OperatorPage.module.css";

/** Меню следует за окном, но привязано к экрану: у нижнего края раскрывается вверх. */
export function TalkMenu({
  label,
  position,
  children,
}: {
  label: string;
  position: Point;
  children: ReactNode;
}) {
  const menu = useRef<HTMLUListElement>(null);
  const [place, setPlace] = useState<ReturnType<typeof placeTalkMenu> | null>(
    null,
  );
  useLayoutEffect(() => {
    const element = menu.current;
    const anchor = element?.parentElement?.querySelector("button");
    if (!element || !anchor) return;
    const update = () => {
      const next = placeTalkMenu(
        anchor.getBoundingClientRect(),
        {
          width: element.offsetWidth,
          height: element.scrollHeight + 2,
        },
        { width: innerWidth, height: innerHeight },
      );
      setPlace((old) =>
        old?.top === next.top &&
        old.left === next.left &&
        old.maxHeight === next.maxHeight
          ? old
          : next,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    const panel = anchor.closest('[data-help="operator-talk"]');
    if (panel) observer.observe(panel);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [position.left, position.top]);
  return (
    <ul
      ref={menu}
      className={styles.menu}
      aria-label={label}
      style={place ?? { visibility: "hidden" }}
    >
      {children}
    </ul>
  );
}
