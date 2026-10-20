// «Тренировка»: обучающее упражнение, которое ученик запускает сам, без преподавателя,
// сколько угодно раз. Сервер закрывает прежнюю тренировку и выдаёт новую карточку —
// кнопка дожидается её и открывает сама: время реакции идёт с момента запуска.
// Перед первой тренировкой — окно «Как устроено обучение» с этапами (DT-18).
import { useState } from "react";
import { ConfirmDialog } from "../ConfirmDialog";
import { useTrainer } from "../trainer/TrainerContext";
import { usePracticeStart } from "./usePracticeStart";
import styles from "../ArmPage.module.css";

export function PracticeButton({
  label = "Тренировка",
  step,
  scenario,
  again,
  title = "Тренировка без подсказок, как занятие. С подсказками — этапы «Смотрю» и «Вместе»",
  className = styles.resultsButton,
  onStarted,
  helpKey,
}: {
  /** Подпись кнопки: в разборе тренировочной карточки — «Пройти тренировку ещё раз». */
  label?: string;
  /** Ступень обучения (evalcore/progress.py); без неё — обучающее упражнение. */
  step?: number;
  /** Сценарий из каталога или повтор незачтённого сценария текущей ступени. */
  scenario?: string;
  /** Карточка из разбора: тот же сценарий ещё раз. */
  again?: string;
  /** Всплывающая подсказка кнопки. */
  title?: string;
  /** Класс кнопки: в «Моём пути» выделена только текущая ступень. */
  className?: string;
  /** Карточка тренировки открыта: окно, из которого запускали, можно закрыть. */
  onStarted?: () => void;
  /** Часть объяснения экрана (data-help); у кнопки в других окнах её нет. */
  helpKey?: string;
} = {}) {
  const trainer = useTrainer();
  const practice = usePracticeStart(onStarted);
  // Каждый запуск подтверждаем; при повторе предупреждаем о прерывании карточки.
  const [asking, setAsking] = useState(false);

  function start() {
    setAsking(false);
    if (practice.disabled) return;
    if (trainer && !trainer.introSeen() && !step && !scenario && !again)
      trainer.openIntro();
    else void practice.start({ step, scenario, again });
  }

  return (
    <>
      <button
        type="button"
        className={className}
        data-help={helpKey}
        disabled={practice.disabled}
        onClick={() => setAsking(true)}
        title={practice.blockedReason || title}
      >
        {label}
      </button>
      {asking && (
        <ConfirmDialog
          title={
            practice.running
              ? "Начать тренировку заново?"
              : "Запустить тренировку?"
          }
          confirmLabel={practice.running ? "Начать заново" : "Запустить"}
          onConfirm={start}
          onCancel={() => setAsking(false)}
        >
          {practice.running
            ? "Текущая тренировочная карточка будет прервана."
            : step
              ? `Начать тренировку ступени ${step}?`
              : "Вы готовы начать тренировку?"}
        </ConfirmDialog>
      )}
      {practice.note &&
        !practice.blockedReason &&
        helpKey !== "tool-practice" && (
          <p role="status" className={styles.practiceNote}>
            {practice.note}
          </p>
        )}
    </>
  );
}

/** Одна общая причина блокировки, вне ряда кнопок. */
export function PracticeAvailabilityNotice() {
  const trainer = useTrainer();
  // Сообщение запуска теперь выводит TrainerProvider, в том числе вне списка.
  const message = trainer?.blockedReason;
  return message ? (
    <p role="status" className={styles.practiceNote}>
      {message}
    </p>
  ) : null;
}
