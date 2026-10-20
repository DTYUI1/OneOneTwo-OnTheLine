import { useEffect, useId, useRef } from "react";
import styles from "./AIResourceDialog.module.css";
import kit from "./Console.module.css";

export function AIResourceDialog({
  action,
  onChoose,
  repeatMessage,
}: {
  action: "generate" | "start";
  repeatMessage?: string;
  onChoose: (choice: "now" | "wait" | "cancel") => void;
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
        onChoose("cancel");
      }}
    >
      <h2 id={titleId}>
        {repeatMessage
          ? "Повтор карточек"
          : action === "generate"
            ? "Сейчас идёт занятие"
            : "Общий локальный ИИ занят"}
      </h2>
      <p>
        {repeatMessage ??
          (action === "generate"
            ? "Осторожно: генерация может помешать работе обучаемых — замедлить ИИ-проверку их работ. Рекомендуем отменить генерацию и запустить её вручную после занятия."
            : "Идёт генерация. Она может задержать ИИ-проверку работ обучаемых.")}
      </p>
      <div className={styles.actions}>
        {!repeatMessage && action === "start" && (
          <button
            type="button"
            className={kit.primary}
            onClick={() => onChoose("wait")}
          >
            Дождаться готовности
          </button>
        )}
        <button
          type="button"
          className={kit.plain}
          onClick={() => onChoose("now")}
        >
          {repeatMessage
            ? "Сгенерировать"
            : action === "generate"
              ? "Сгенерировать сейчас"
              : "Начать сейчас"}
        </button>
        <button
          type="button"
          className={kit.plain}
          onClick={() => onChoose("cancel")}
        >
          Отмена
        </button>
      </div>
    </dialog>
  );
}
