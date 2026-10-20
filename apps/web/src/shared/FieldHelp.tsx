import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./FieldHelp.module.css";

/** Короткая справка: доступна мышью, касанием и с клавиатуры. */
export function FieldHelp({
  label,
  children,
}: {
  label: string;
  children: string;
}) {
  const id = useId();
  const trigger = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pinned = useRef(false);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const cancelClose = () => clearTimeout(timer.current);
  const close = () => {
    cancelClose();
    pinned.current = false;
    setPosition(null);
  };
  const show = () => {
    cancelClose();
    const box = trigger.current?.getBoundingClientRect();
    if (box)
      setPosition({
        left: Math.max(8, Math.min(box.left, window.innerWidth - 328)),
        top: box.bottom,
      });
  };
  const leave = () => {
    cancelClose();
    timer.current = setTimeout(() => {
      if (!pinned.current && document.activeElement !== trigger.current)
        setPosition(null);
    }, 150);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!position) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const outside = (event: PointerEvent) => {
      if (
        !trigger.current?.contains(event.target as Node) &&
        !bubble.current?.contains(event.target as Node)
      )
        close();
    };
    const move = () => {
      // При переходе Tab браузер может прокрутить поле уже после onFocus.
      // Справка должна остаться рядом с ним, а не сразу исчезнуть.
      if (document.activeElement === trigger.current) show();
      else close();
    };
    document.addEventListener("keydown", dismiss);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", move);
    window.addEventListener("scroll", move, true);
    return () => {
      document.removeEventListener("keydown", dismiss);
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", move);
      window.removeEventListener("scroll", move, true);
    };
  }, [position]);
  return (
    <>
      <span
        ref={trigger}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.currentTarget.click();
          }
        }}
        className={styles.trigger}
        aria-label={`Пояснение: ${label}`}
        aria-describedby={position ? id : undefined}
        aria-expanded={Boolean(position)}
        onMouseEnter={show}
        onMouseLeave={leave}
        onFocus={show}
        onBlur={close}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (pinned.current) close();
          else {
            pinned.current = true;
            show();
          }
        }}
      >
        <span aria-hidden="true">?</span>
      </span>
      {position &&
        createPortal(
          <span
            ref={bubble}
            id={id}
            role="tooltip"
            className={styles.bubble}
            style={{
              left: position.left,
              ...(position.top > window.innerHeight - 180
                ? { bottom: window.innerHeight - position.top + 24 }
                : { top: position.top }),
            }}
            onMouseEnter={cancelClose}
            onMouseLeave={leave}
          >
            {children}
          </span>,
          document.body,
        )}
    </>
  );
}

export function FieldCaption({ label, help }: { label: string; help: string }) {
  return (
    <span className={styles.caption}>
      {label}
      <FieldHelp label={label}>{help}</FieldHelp>
    </span>
  );
}
