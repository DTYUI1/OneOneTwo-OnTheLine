// Проводник тренировки в карточке: весь порядок работы с отметкой текущего шага.
// Учебное дополнение — в боевом АРМ его нет, поэтому подписано «Тренировка».
import { useState } from "react";
import { WorkflowSteps } from "../../shared/WorkflowGuide";
import { PracticeButton } from "./PracticeButton";
import { tutorProgress, type TutorInput } from "./tutor";
import {
  headlineVariants,
  reminderVariants,
  tutorHeadline,
  tutorReminders,
} from "./tutorLines";
import armStyles from "../ArmPage.module.css";
import styles from "./TutorPanel.module.css";

export function TutorPanel({
  input,
  onReview,
}: {
  input: TutorInput;
  /** Открыть разбор закрытой карточки. */
  onReview?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const progress = tutorProgress(input);
  // Пропущенные шаги и адрес — одной строкой, чтобы полоса проводника не росла.
  const reminders = tutorReminders(progress);
  const headline = tutorHeadline(progress);
  return (
    <section className={styles.panel} aria-label="Проводник тренировки">
      <div className={styles.row}>
        <span className={styles.badge}>Тренировка</span>
        {/* Невидимые варианты в той же клетке держат высоту самой длинной строки:
            смена шага и «Не забудьте…» не сдвигают карточку под полосой. */}
        <div className={styles.now} role="status">
          <div className={styles.slot}>
            <div>
              {headline && (
                <>
                  <strong>{headline.strong}</strong> {headline.rest}
                </>
              )}
            </div>
            {HEADLINE_SIZERS}
          </div>
          <div className={styles.slot}>
            <p className={styles.missed}>
              {reminders.length > 0 && `Не забудьте: ${reminders.join("; ")}.`}
            </p>
            {REMINDER_SIZERS}
          </div>
        </div>
        {progress.finished ? (
          // Разбор и повтор — рядом: за новой попыткой не нужно идти в список.
          <div className={styles.actions}>
            {onReview && (
              // Разбор — главное действие после упражнения, поэтому он первый
              // и выделен так же, как «Ещё раз».
              <button
                type="button"
                className={armStyles.resultsButton}
                onClick={onReview}
              >
                Разбор
              </button>
            )}
            <PracticeButton label="Ещё раз" />
          </div>
        ) : (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Скрыть шаги" : "Все шаги"}
          </button>
        )}
      </div>
      {expanded && (
        <WorkflowSteps current={progress.current} done={progress.done} />
      )}
    </section>
  );
}

// Варианты — текстом псевдоэлемента (data-text): их нет ни в дереве доступности,
// ни в тексте полосы, поиск «Шаг 3 из 8» находит только видимую строку.
const HEADLINE_SIZERS = headlineVariants().map((line) => (
  <div key={line.strong} className={styles.sizer} aria-hidden="true">
    <strong data-text={line.strong} /> <span data-text={line.rest} />
  </div>
));

const REMINDER_SIZERS = reminderVariants().map((line) => (
  <p
    key={line}
    className={`${styles.missed} ${styles.sizer}`}
    aria-hidden="true"
    data-text={`Не забудьте: ${line}.`}
  />
));
