import { useEffect, useState } from "react";
import kit from "../teacher/console/Console.module.css";
import styles from "./Admin.module.css";

/** Скрывается только текущая сводка в открытой админке, без отметок на сервере. */
export function AdminWarningBanner({
  warnings,
  hidden,
  hasQueueErrors,
  onHealth,
  onJobErrors,
}: {
  warnings: string[];
  hidden: boolean;
  hasQueueErrors: boolean;
  onHealth: () => void;
  onJobErrors: () => void;
}) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const signature = JSON.stringify(warnings);
  // Исчезновение или изменение причины завершает прежнее скрытие.
  // Если такая же причина возникнет снова, это уже новое предупреждение.
  useEffect(() => setDismissed(null), [signature]);
  if (hidden || warnings.length === 0 || dismissed === signature) return null;
  return (
    <div className={`${kit.warning} ${styles.warningBanner}`} role="status">
      <div className={styles.warningContent}>
        <span>{warnings.join(" ")}</span>
        <button type="button" className={kit.plain} onClick={onHealth}>
          Состояние системы
        </button>
        {hasQueueErrors && (
          <button type="button" className={kit.plain} onClick={onJobErrors}>
            Открыть ошибки очереди
          </button>
        )}
      </div>
      <button
        type="button"
        className={kit.plain}
        aria-label="Скрыть предупреждение"
        title="Скрыть предупреждение — ошибки останутся непрочитанными"
        onClick={() => setDismissed(signature)}
      >
        ×
      </button>
    </div>
  );
}
