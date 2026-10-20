// Кнопка «Проверьте себя» и окно теста по памятке ДДС (quizModel). Результат в оценку
// не идёт: это самопроверка перед тренировкой. Ошибки помнит только браузер — следующий
// тест начинается с них; после 5 из 5 отсюда же запускается тренировка.
//
// Кнопка — в окне «Порядок работы» (просьба капитана 19.10): прочитал порядок — проверь
// себя. Список происшествий отдаёт её окну через useWorkflowExtra; окно теста — поверх
// страницы (портал): «Порядок работы» перед ним закрывается.
import { useState } from "react";
import { createPortal } from "react-dom";
import { Dialog } from "../Dialog";
import { PracticeButton } from "../practice/PracticeButton";
import {
  loadMissed,
  pickQuiz,
  quizScore,
  remainingLabel,
  saveMissed,
  updateMissed,
  type QuizItem,
} from "./quizModel";
import arm from "../ArmPage.module.css";
import styles from "./Quiz.module.css";

/** Строка в окне «Порядок работы»: пояснение и кнопка теста. */
export function QuizInWorkflow({ close }: { readonly close: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <span>Прочитали порядок? Пять вопросов по памятке ДДС.</span>
      <button
        type="button"
        className={arm.resultsButton}
        onClick={() => {
          close();
          setOpen(true);
        }}
        title="Пять вопросов по памятке ДДС: статусы, сроки, комментарии"
      >
        Проверьте себя
      </button>
      {open &&
        createPortal(
          <QuizDialog onClose={() => setOpen(false)} />,
          document.body,
        )}
    </>
  );
}

function QuizDialog({ onClose }: { onClose: () => void }) {
  const [quiz, setQuiz] = useState<QuizItem[]>(() =>
    pickQuiz(5, Math.random, loadMissed()),
  );
  const [answers, setAnswers] = useState<(number | null)[]>(() =>
    quiz.map(() => null),
  );
  const [checked, setChecked] = useState(false);
  const again = () => {
    const next = pickQuiz(5, Math.random, loadMissed());
    setQuiz(next);
    setAnswers(next.map(() => null));
    setChecked(false);
  };
  const check = () => {
    saveMissed(updateMissed(loadMissed(), quiz, answers));
    setChecked(true);
  };
  const score = quizScore(quiz, answers);
  const unanswered = answers.some((value) => value === null);
  return (
    <div className={styles.backdrop}>
      <Dialog
        label="Проверьте себя"
        className={styles.dialog}
        onClose={onClose}
      >
        <h2>Проверьте себя: памятка ДДС</h2>
        <ol className={styles.questions}>
          {quiz.map((item, index) => (
            <li key={item.id}>
              <fieldset className={styles.question}>
                <legend>
                  {index + 1}. {item.text}
                </legend>
                {item.shown.map((option, choice) => {
                  const mark =
                    checked && choice === item.correct
                      ? styles.right
                      : checked && choice === answers[index]
                        ? styles.wrong
                        : undefined;
                  return (
                    <label key={option} className={mark}>
                      <input
                        type="radio"
                        name={`quiz-${item.id}`}
                        disabled={checked}
                        checked={answers[index] === choice}
                        onChange={() =>
                          setAnswers(
                            answers.map((value, at) =>
                              at === index ? choice : value,
                            ),
                          )
                        }
                      />{" "}
                      {option}
                    </label>
                  );
                })}
                {checked && (
                  <p className={styles.explain}>
                    {answers[index] === item.correct ? "Верно. " : "Неверно. "}
                    {item.explain} <em>{item.source}.</em>
                  </p>
                )}
              </fieldset>
            </li>
          ))}
        </ol>
        {checked && (
          <p role="status" className={styles.result}>
            Верно {score} из {quiz.length}.
            {score === quiz.length
              ? " Можно переходить к тренировке."
              : " Перечитайте пояснения — вопросы с ошибками вернутся первыми."}
          </p>
        )}
        <div className={styles.actions}>
          {checked && score === quiz.length ? (
            <>
              <PracticeButton
                label="Начать тренировку"
                className={styles.primary}
                onStarted={onClose}
              />
              <button type="button" onClick={again}>
                Другие вопросы
              </button>
            </>
          ) : checked ? (
            <button type="button" className={styles.primary} onClick={again}>
              Повторить ошибки
            </button>
          ) : (
            <button
              type="button"
              className={styles.primary}
              disabled={unanswered}
              onClick={check}
            >
              Проверить
            </button>
          )}
          <button type="button" onClick={onClose}>
            Закрыть
          </button>
        </div>
        {!checked && unanswered && (
          <p className={styles.remaining}>
            Ответьте на все вопросы: {remainingLabel(answers, quiz.length)}
          </p>
        )}
      </Dialog>
    </div>
  );
}
