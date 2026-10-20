import { useEffect, useId, useRef } from "react";
import styles from "../console/AIResourceDialog.module.css";
import kit from "../console/Console.module.css";
import studio from "./Studio.module.css";

export function CoherenceBadge({ unchecked }: { unchecked?: boolean }) {
  return unchecked ? (
    <span
      className={studio.st_draft}
      title="Автоматическая проверка не прошла сценарий целиком. Перед выдачей проверьте его в предпросмотре."
    >
      Сценарий не проверен автоматически
    </span>
  ) : null;
}

export function CoherenceWarning({
  onChoose,
}: {
  onChoose: (confirmed: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onChoose(false);
      }}
    >
      <h2 id={titleId}>Сценарий не проверен автоматически</h2>
      <p>
        Автоматическая проверка не смогла пройти этот сценарий целиком:
        проверить действия бригады, события и исход при разных действиях обучаемого. Перед
        выдачей откройте предпросмотр и проверьте сами. Утвердить без
        автоматической проверки?
      </p>
      <div className={styles.actions}>
        <button
          type="button"
          className={kit.plain}
          onClick={() => onChoose(false)}
        >
          Вернуться к проверке
        </button>
        <button
          type="button"
          className={kit.primary}
          onClick={() => onChoose(true)}
        >
          Утвердить без проверки
        </button>
      </div>
    </dialog>
  );
}
