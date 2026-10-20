// Окно поверх реестра (карточка, результаты, справка) — диалог для клавиатуры:
// фокус переходит внутрь, Tab не уходит за окно, Esc закрывает как кнопка «✕»,
// после закрытия фокус возвращается туда, откуда окно открыли (строка реестра).
import { useEffect, useRef, type ReactNode } from "react";

const FOCUSABLE =
  'summary, a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  label,
  className,
  onClose,
  children,
}: {
  label: string;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    ref.current?.focus();
    // Щелчок по затемнению снимает фокус с окна. Тогда React-обработчик
    // внутри диалога не получает Esc, а карточка под ним может закрыться.
    const escapeOutside = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const dialog = ref.current;
      if (
        !dialog ||
        (event.target instanceof Node && dialog.contains(event.target))
      )
        return;
      const dialogs = document.querySelectorAll(
        '[role="dialog"][aria-modal="true"]',
      );
      if (dialogs[dialogs.length - 1] !== dialog) return;
      event.preventDefault();
      event.stopPropagation();
      close.current();
    };
    document.addEventListener("keydown", escapeOutside, true);
    return () => {
      document.removeEventListener("keydown", escapeOutside, true);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      close.current();
      return;
    }
    if (event.key !== "Tab" || !ref.current) return;
    const items = [
      ...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE),
    ].filter((item) => item.getClientRects().length > 0);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const current = document.activeElement;
    if (event.shiftKey && (current === first || current === ref.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      className={className}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}
