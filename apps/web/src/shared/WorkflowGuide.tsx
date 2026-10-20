// «Порядок работы» — полный сценарий действий обучаемого одним списком (учебная функция,
// как «Мои результаты»; в боевом АРМ её нет). Открывается из шапки в любой момент и
// показан в приветствии: ученик заранее знает весь путь карточки.
//
// Страница может дополнить окно своей кнопкой (`useWorkflowExtra`): список происшествий —
// «Проверьте себя» по памятке ДДС (просьба капитана 19.10: тест — рядом с порядком, а не в
// ряду учебных кнопок). Окно общее (shared), тест — модуль ДДС (arm/quiz): страница отдаёт
// компонент, как справке «?» — объяснение экрана.
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
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

/** Дополнение окна: `close` закрывает «Порядок работы» перед своим окном. */
export type WorkflowExtra = ComponentType<{ readonly close: () => void }>;

const ExtraContext = createContext<{
  readonly extra: WorkflowExtra | null;
  readonly setExtra: (extra: WorkflowExtra | null) => void;
} | null>(null);

export function WorkflowProvider({ children }: { children: ReactNode }) {
  const [extra, setExtra] = useState<WorkflowExtra | null>(null);
  const value = useMemo(
    () => ({
      extra,
      // Компонент — функция: в useState его кладут через функцию-обёртку.
      setExtra: (next: WorkflowExtra | null) => setExtra(() => next),
    }),
    [extra],
  );
  return (
    <ExtraContext.Provider value={value}>{children}</ExtraContext.Provider>
  );
}

/** Страница дополняет «Порядок работы», пока она открыта. `extra` — постоянная ссылка. */
export function useWorkflowExtra(extra: WorkflowExtra | null) {
  const setExtra = useContext(ExtraContext)?.setExtra;
  useEffect(() => {
    if (!setExtra) return;
    setExtra(extra);
    return () => setExtra(null);
    // setExtra пересоздаётся вместе с самим дополнением, но внутри — постоянный сеттер
    // useState: следим только за дополнением, иначе эффект крутился бы по кругу.
  }, [extra]);
}

/** Кнопка шапки и окно со всем порядком работы. Esc и «Закрыть» закрывают окно. */
export function WorkflowButton() {
  const dialog = useRef<HTMLDialogElement>(null);
  const Extra = useContext(ExtraContext)?.extra ?? null;
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
          не отметили статус, она ждёт. Пройти путь с подсказками можно этапами
          «Смотрю» и «Вместе» в шапке списка происшествий — сколько угодно раз.
        </p>
        {Extra && (
          <div className={styles.extra}>
            <Extra close={() => dialog.current?.close()} />
          </div>
        )}
        <WorkflowSteps />
      </dialog>
    </>
  );
}
