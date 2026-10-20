// «Начать занятие» — в одном ряду с кнопкой выдачи; что ещё мешает старту — под этим рядом.
// Отдельный шаг «Начало занятия» — только когда выдачи на экране нет (задания готовит ИИ).
import styles from "./Console.module.css";

export type StartControl = {
  blockers: string[];
  pending: boolean;
  onStart: () => void;
};

export function StartButton({ start }: { start: StartControl }) {
  return (
    <button
      type="button"
      className={styles.primary}
      disabled={start.blockers.length > 0 || start.pending}
      onClick={start.onStart}
    >
      Начать занятие
    </button>
  );
}

export function StartStatus({ start }: { start: StartControl }) {
  if (start.blockers.length === 0)
    return (
      <p className={styles.hint}>
        Задания выданы всем местам. Карточки придут обучаемым по плану.
      </p>
    );
  return (
    <>
      <p className={styles.hint}>
        «Начать занятие» станет доступной, когда у каждого места будут задания.
      </p>
      <ul className={styles.blockers} role="status">
        {start.blockers.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </>
  );
}

export function StartStep({ start }: { start: StartControl }) {
  return (
    <div className={styles.panel}>
      <h3 className={styles.panelTitle}>Начало занятия</h3>
      <StartStatus start={start} />
      <div className={styles.actions}>
        <StartButton start={start} />
      </div>
    </div>
  );
}
