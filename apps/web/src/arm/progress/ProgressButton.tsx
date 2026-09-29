// «Мой путь»: четыре ступени обучения, где обучаемый сейчас и что осталось. Каждую
// открытую ступень можно тренировать самому; уровень на занятии ставит преподаватель.
// Выделена одна кнопка — текущей ступени: что делать дальше, решает путь, а не обучаемый.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api";
import { Dialog } from "../Dialog";
import { PracticeButton } from "../practice/PracticeButton";
import {
  barWidth,
  nextAction,
  remaining,
  STATE_LABELS,
  stepState,
} from "./progressModel";
import arm from "../ArmPage.module.css";
import styles from "./Progress.module.css";

export function ProgressButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={arm.resultsButton}
        onClick={() => setOpen(true)}
        title="Ступени обучения: где вы сейчас и что осталось"
      >
        Мой путь
      </button>
      {open && <ProgressDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function ProgressDialog({ onClose }: { onClose: () => void }) {
  const progress = useQuery({
    queryKey: ["progress"],
    queryFn: async () => {
      const { data, error } = await api.GET("/progress");
      if (!data) throw new Error(error?.message ?? "Путь недоступен.");
      return data[0] ?? null;
    },
  });
  const own = progress.data;
  const next = own && own.steps.length > 0 ? nextAction(own.steps) : null;
  return (
    <div className={styles.backdrop}>
      <Dialog label="Мой путь" className={styles.dialog} onClose={onClose}>
        <h2>Мой путь: ступени обучения</h2>
        {progress.isPending && <p>Загружаем…</p>}
        {progress.isError && <p role="alert">{progress.error.message}</p>}
        {next?.done && (
          <p className={styles.note}>
            Все ступени пройдены — закрепляйте на ступени {next.step.number}.
          </p>
        )}
        {own && (
          <ol className={styles.steps}>
            {own.steps.map((step) => {
              const state = stepState(step, own.current_step);
              return (
                <li
                  key={step.number}
                  className={styles.step}
                  data-state={state}
                >
                  <div className={styles.stepHead}>
                    <strong>
                      Ступень {step.number}. {step.title}
                    </strong>
                    <span className={styles.chip}>{STATE_LABELS[state]}</span>
                  </div>
                  <p>{step.skill}.</p>
                  <div
                    className={styles.bar}
                    role="progressbar"
                    aria-label={`Ступень ${step.number}`}
                    aria-valuemin={0}
                    aria-valuemax={step.required}
                    aria-valuenow={step.passed ? step.required : step.streak}
                  >
                    <i
                      style={{
                        width: `${barWidth(step.passed ? step.required : step.streak, step.required)}%`,
                      }}
                    />
                  </div>
                  <p className={styles.muted}>{remaining(step)}</p>
                  {step.unlocked && (
                    <PracticeButton
                      step={step.number}
                      label={`Тренироваться: ступень ${step.number}`}
                      className={
                        step.number === next?.step.number ? styles.primary : ""
                      }
                      onStarted={onClose}
                    />
                  )}
                </li>
              );
            })}
          </ol>
        )}
        <p className={styles.note}>
          Засчитываются карточки занятий и тренировок с оценкой «Зачтено» без
          критических ошибок. Уровень на занятии выбирает преподаватель.
        </p>
        <div className={styles.actions}>
          <button type="button" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </Dialog>
    </div>
  );
}
