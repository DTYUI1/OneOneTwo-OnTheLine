// Окно результата и разбор звонка (этап 3, как в прототипе docs/operator_112_review/
// prototype/): слева — баллы с пояснениями, эталонный порядок и «Пройти заново», справа —
// лента разговора с пометками (помогло / навредило / внимание) и время шагов опроса.

import type { CallScenario } from "./data";
import { STEP_TITLES } from "./dialog";
import { MARK_LABELS, clock, panicChange, type CallJournal } from "./journal";
import styles from "./OperatorPage.module.css";
import type { AttemptResult, AttemptSummary } from "./save";

const WHO_SAID = "Вы";
const WHO_REPLIED = "Заявитель";

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Итог словами — как в прототипе: что делать дальше. */
export function verdict(total: number, max: number): string {
  const share = max > 0 ? total / max : 0;
  if (share >= 0.85) return "Отличный звонок.";
  if (share >= 0.6) return "Хорошо, но есть что улучшить — смотрите разбор.";
  return "Звонок стоит пройти ещё раз — разбор подскажет, где потеряны баллы.";
}

export function StepTimes({ journal }: { journal: CallJournal }) {
  return (
    <ol className={styles.stepTimes} aria-label="Время шагов опроса">
      {STEP_TITLES.map((title, index) => {
        const passed = journal.steps.find((item) => item.step === index + 1);
        return (
          <li key={title} data-done={Boolean(passed)}>
            <span>
              {index + 1}. {title}
            </span>
            <time>{passed ? clock(passed.t) : "не пройден"}</time>
          </li>
        );
      })}
    </ol>
  );
}

export function Timeline({ journal }: { journal: CallJournal }) {
  if (journal.events.length === 0)
    return <p className={styles.reviewEmpty}>Разговора не было.</p>;
  return (
    <ol className={styles.timeline} aria-label="Лента разговора">
      {journal.events.map((event, index) => (
        <li key={index}>
          <time>{clock(event.t)}</time>
          <div>
            {event.said && (
              <p>
                <span>{WHO_SAID}:</span> {event.said}
              </p>
            )}
            {event.reply && (
              <p>
                <span>{WHO_REPLIED}:</span> {event.reply}
              </p>
            )}
            {event.note && <p className={styles.talkNote}>{event.note}</p>}
            {event.mark && (
              <p className={styles.mark} data-kind={event.mark.kind}>
                {MARK_LABELS[event.mark.kind]}: {event.mark.text}{" "}
                {panicChange(event)}
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Баллы попытки: итог, вывод словами, критерии с пояснениями и эталонный порядок звонка. */
export function AttemptScore({
  result,
  scenario,
}: {
  result: AttemptResult;
  /** Сценарий из ротации; у архивного звонка эталонного порядка нет. */
  scenario: CallScenario | undefined;
}) {
  return (
    <>
      <p className={styles.resultTotal}>
        {result.total} из {result.max_total}
      </p>
      <p className={styles.resultVerdict}>
        {verdict(result.total, result.max_total)}
      </p>
      <ul className={styles.resultCriteria}>
        {result.criteria.map((criterion) => (
          <li key={criterion.key}>
            <div className={styles.resultCriterionHead}>
              <span>{criterion.title}</span>
              <span>
                {criterion.points} / {criterion.weight}
              </span>
            </div>
            <p>{criterion.explanation}</p>
          </li>
        ))}
      </ul>
      {scenario && (
        <>
          <h3>Эталонный порядок</h3>
          <ol className={styles.referenceOrder}>
            {scenario.reference_order.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        </>
      )}
    </>
  );
}

export function Review({
  result,
  attempts,
  scenario,
  onClose,
  onRestart,
}: {
  result: AttemptResult;
  attempts: readonly AttemptSummary[];
  scenario: CallScenario;
  onClose: () => void;
  onRestart: () => void;
}) {
  return (
    <div className={styles.backdrop}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="operator-result-title"
        className={styles.result}
      >
        <header className={styles.resultHeader}>
          <h2 id="operator-result-title">Результат попытки</h2>
          <button
            type="button"
            className={styles.resultClose}
            aria-label="Закрыть"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className={styles.resultBody}>
          <section
            className={styles.resultScore}
            tabIndex={0}
            aria-labelledby="operator-result-title"
          >
            <AttemptScore result={result} scenario={scenario} />
            {attempts.length > 0 && (
              <>
                <h3>Ваши попытки</h3>
                <ul className={styles.resultAttempts}>
                  {attempts.map((attempt) => (
                    <li key={attempt.id}>
                      <span>{attempt.scenario_title}</span>
                      <span>{formatDate(attempt.created_at)}</span>
                      <span>
                        {attempt.total} / {attempt.max_total}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
          <section
            className={styles.resultReview}
            tabIndex={0}
            aria-labelledby="operator-review-title"
          >
            <h3 id="operator-review-title">Разбор звонка</h3>
            <StepTimes journal={result.journal} />
            <Timeline journal={result.journal} />
          </section>
        </div>
        <div className={styles.resultButtons}>
          <button
            type="button"
            className={styles.resultPrimary}
            onClick={onRestart}
          >
            Пройти заново
          </button>
          <button type="button" onClick={onClose}>
            Закрыть разбор
          </button>
        </div>
      </div>
    </div>
  );
}
