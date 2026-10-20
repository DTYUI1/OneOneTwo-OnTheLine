import { useEffect, useRef, useState, type RefObject } from "react";

/** По физической клавише: русская раскладка не меняет комбинации. */
export const OPERATOR_SHORTCUTS = [
  ["F1", "Alt+F1", "АОН"],
  ["F2", "Alt+F2", "предоставленный телефон"],
  ["F3", "Alt+F3", "телефон на место"],
  ["KeyQ", "Alt+Q", "заявитель"],
  ["KeyA", "Alt+A", "адрес"],
  ["KeyP", "Alt+P", "пострадавшие"],
  ["KeyN", "Alt+N", "нет контакта / срыв звонка"],
  ["KeyT", "Alt+T", "что случилось"],
  ["KeyR", "Alt+R", "значимый тип"],
  ["KeyO", "Alt+O", "описание"],
  ["KeyZ", "Alt+Z", "службы"],
  ["Digit1", "Alt+1", "опросная карта"],
  ["KeyS", "Alt+S", "сохранить"],
  ["KeyW", "Alt+W", "создать связь"],
  ["KeyB", "Alt+B", "напоминание"],
  ["KeyV", "Alt+V", "важное происшествие"],
  ["KeyM", "Alt+M", "сообщить о проблеме"],
] as const;

export function useOperatorShortcuts(
  root: RefObject<HTMLDivElement>,
  enabled: boolean,
  onEscape: () => void,
  blocked: boolean,
) {
  const [held, setHeld] = useState(false);
  const escape = useRef(onEscape);
  escape.current = onEscape;
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code === "AltLeft" || event.code === "AltRight") {
        setHeld(true);
        return;
      }
      if (event.key === "Escape" && enabled && !event.defaultPrevented) {
        escape.current();
        return;
      }
      if (
        !enabled ||
        blocked ||
        !event.altKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      let target: HTMLElement | null = null;
      if (event.ctrlKey && /^Digit[1-9]$/.test(event.code)) {
        const group = root.current?.querySelectorAll<HTMLElement>(
          '[data-help="operator-card"] [role="group"]',
        )[Number(event.code.slice(-1)) - 1];
        target = group?.querySelector<HTMLElement>("input, button") ?? null;
      } else if (
        !event.ctrlKey &&
        OPERATOR_SHORTCUTS.some(([code]) => code === event.code)
      ) {
        const region = root.current?.querySelector<HTMLElement>(
          `[data-shortcut~="${event.code}"]`,
        );
        target = region?.matches("input, textarea, select, button")
          ? region
          : event.code === "Digit1"
            ? (region?.querySelector<HTMLElement>(
                '[role="group"] input, [role="group"] button',
              ) ?? null)
            : (region?.querySelector<HTMLElement>("input, textarea, select") ??
              region?.querySelector<HTMLElement>("button") ??
              null);
      }
      if (!target || target.matches(":disabled")) return;
      event.preventDefault();
      if (event.repeat) return;
      if (target.dataset.shortcutAction === "click") target.click();
      else {
        target.focus();
        if (target instanceof HTMLInputElement && !target.readOnly)
          target.select();
      }
    };
    const clear = () => setHeld(false);
    const up = (event: KeyboardEvent) => {
      if (event.code === "AltLeft" || event.code === "AltRight") clear();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
    };
  }, [enabled, blocked, root]);
  return held;
}
