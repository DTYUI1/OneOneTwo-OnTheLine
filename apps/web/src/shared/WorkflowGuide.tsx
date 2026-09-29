// «Порядок работы» — полный сценарий действий обучаемого одним списком (учебная функция,
// как «Мои результаты»; в боевом АРМ её нет). Открывается из шапки в любой момент и
// показан в приветствии: ученик заранее знает весь путь карточки.
import { useRef } from "react";
import { WORKFLOW_STEPS } from "./workflow";
import styles from "./WorkflowGuide.module.css";

/** Нумерованный список шагов; `current` выделяет шаг, на котором ученик сейчас. */
export function WorkflowSteps({
  current,
  done,
}: {
  current?: string | null;
  done?: ReadonlySet<string>;
}) {
  return (
    <ol className={styles.steps}>
      {WORKFLOW_STEPS.map((step) => (
        <li
          key={step.id}
          className={
            step.id === current
              ? styles.current
              : done?.has(step.id)
                ? styles.done
                : undefined
          }
          aria-current={step.id === current ? "step" : undefined}
        >
          <strong>
            {step.title}
            {done?.has(step.id) && step.id !== current ? " — сделано" : ""}
          </strong>
          <span>{step.action}</span>
        </li>
      ))}
    </ol>
  );
}

/** Кнопка шапки и окно со всем порядком работы. Esc и «Закрыть» закрывают окно. */
export function WorkflowButton() {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button type="button" onClick={() => dialog.current?.showModal()}>
        Порядок работы
      </button>
      <dialog
        ref={dialog}
        className={styles.dialog}
        aria-labelledby="workflow-heading"
      >
        <header className={styles.head}>
          <h2 id="workflow-heading">Порядок работы с карточкой</h2>
          <button type="button" onClick={() => dialog.current?.close()}>
            Закрыть
          </button>
        </header>
        <p className={styles.lead}>
          Весь путь происшествия — от поступления карточки до доклада о
          завершении работ. Бригада действует только по вашим решениям: пока вы
          не отметили статус, она ждёт. Потренироваться можно кнопкой
          «Тренировка» в списке происшествий — сколько угодно раз.
        </p>
        <WorkflowSteps />
      </dialog>
    </>
  );
}
