// Подтверждение действия поверх экрана вместо системного window.confirm: окно в стиле
// АРМ (тёмная полоса, как шапка карточки), фокус внутри, Esc — как «отмена».
import { useState, type ReactNode } from "react";
import { Dialog } from "./Dialog";
import styles from "./ConfirmDialog.module.css";

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = "Отмена",
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className={styles.backdrop}>
      <Dialog label={title} className={styles.dialog} onClose={onCancel}>
        <h2>{title}</h2>
        <p>{children}</p>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.primary}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onConfirm();
            }}
          >
            {confirmLabel}
          </button>
          <button
            type="button"
            className={styles.plain}
            disabled={busy}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
        </div>
      </Dialog>
    </div>
  );
}
