// Окно «Проверка памяти» финальной смены (HQ-033) — стоп-кадр прототипа A (02.10): три
// вопроса об обстановке с вариантами, «Проверить», верно N из 3, «Продолжить смену».
// Решение 18.10: без паузы — смена идёт дальше, поэтому окно не модальное: панель у левого
// края ниже окна телефона, её можно свернуть и вернуться; пока звонят или идёт разговор —
// ждёт, но не дольше срока (memoryCheckDue). Вопросы — с сервера, на момент показа; не
// получили (нет связи, сервер ещё не видит карточек) — запрос повторяется.
import { useEffect, useRef, useState } from "react";
import { api, csrfToken, type Card } from "../../shared/api";
import { useQueryClient } from "@tanstack/react-query";
import { useNow } from "../useNow";
import { isClosed } from "../cardModel";
import {
  MEMORY_RETRY_MS,
  memoryCheckDue,
  memoryCheckFinal,
  optionVerdict,
  pick,
  type MemoryCheck,
} from "./memoryCheck";
import styles from "./MemoryCheck.module.css";

export function MemoryCheckWindow({
  sessionId,
  cards,
  expected,
  talking,
  ringing,
}: {
  readonly sessionId: string;
  /** Карточки этой смены. */
  readonly cards: readonly Card[];
  /** Сколько карточек в смене (`settings.parallel_cards`). */
  readonly expected: number;
  /** Идёт разговор. */
  readonly talking: boolean;
  /** Звонят: вызов бригады (тревога) или отдел контроля. */
  readonly ringing: boolean;
}) {
  const now = useNow();
  const client = useQueryClient();
  // Запрос вопросов: идёт или окончательно не нужен; повтор после сбоя — не раньше retryAt.
  const asked = useRef(false);
  const [retryAt, setRetryAt] = useState(0);
  const [check, setCheck] = useState<MemoryCheck | null>(null);
  const [chosen, setChosen] = useState<string[][]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  const [folded, setFolded] = useState(false);
  const due = memoryCheckDue({
    appearedMs: cards.map((card) => Date.parse(card.appeared_at)),
    expected,
    openCount: cards.filter((card) => !isClosed(card) && !card.interrupted_at)
      .length,
    now,
    talking,
    ringing,
  });
  const retryDue = now >= retryAt;
  useEffect(() => {
    if (!due || !retryDue || asked.current) return;
    asked.current = true;
    const retry = () => {
      asked.current = false;
      setRetryAt(Date.now() + MEMORY_RETRY_MS);
    };
    void (async () => {
      try {
        const { data, error } = await api.POST("/sessions/{id}/memory-check", {
          params: {
            path: { id: sessionId },
            header: { "X-CSRF-Token": csrfToken() },
          },
        });
        if (!data) {
          // Смена кончилась или проверки в ней нет — больше не спрашиваем; иначе
          // (сервер ещё не видит карточек смены, сбой) — повторим позже.
          if (!memoryCheckFinal(error)) retry();
          return;
        }
        // Уже отвечал (обновили страницу) — окно не показываем.
        if (data.result) return;
        setCheck(data);
        setChosen(data.questions.map(() => []));
      } catch {
        retry();
      }
    })();
  }, [due, retryDue, sessionId]);

  if (!check || closed) return null;
  const result = check.result;
  const ready = chosen.length > 0 && chosen.every((items) => items.length > 0);
  async function submit() {
    if (!check) return;
    setSending(true);
    setError(null);
    const { data } = await api.POST("/sessions/{id}/memory-check/answers", {
      params: {
        path: { id: sessionId },
        header: { "X-CSRF-Token": csrfToken() },
      },
      body: { answers: chosen },
    });
    setSending(false);
    if (!data?.result) {
      setError("Ответ не сохранён — проверьте связь и нажмите ещё раз.");
      return;
    }
    setCheck(data);
    setChosen(data.result.answers.map((items) => [...items]));
    // Запись в журнале первой карточки — разбор читает итог оттуда.
    void client.invalidateQueries({ queryKey: ["card-events", data.card_id] });
  }
  return (
    <section
      className={styles.window}
      aria-label="Проверка памяти"
      data-folded={folded}
    >
      <header className={styles.head}>
        <h2>Проверка памяти</h2>
        <button
          type="button"
          className={styles.fold}
          aria-expanded={!folded}
          onClick={() => setFolded(!folded)}
        >
          {folded ? "Развернуть" : "Свернуть"}
        </button>
      </header>
      {!folded && (
        <div className={styles.content}>
          <p className={styles.note}>
            Смена не останавливается. Не подглядывайте — ответьте по памяти: так
            проверяется картина обстановки.
          </p>
          {check.questions.map((question, index) => (
            <div
              key={question.key}
              className={styles.question}
              data-memory-question={question.key}
            >
              <p>
                <b>{index + 1}.</b> {question.text}
                {question.multiple && (
                  <span className={styles.hint}> Отметьте все верные.</span>
                )}
              </p>
              <div className={styles.options}>
                {question.options.map((option) => {
                  const mine = chosen[index] ?? [];
                  const verdict = result
                    ? optionVerdict(result.correct[index] ?? [], mine, option)
                    : null;
                  return (
                    <button
                      key={option}
                      type="button"
                      className={styles.option}
                      aria-pressed={mine.includes(option)}
                      data-verdict={verdict ?? undefined}
                      disabled={result !== null || sending}
                      onClick={() =>
                        setChosen((old) =>
                          old.map((items, at) =>
                            at === index
                              ? pick(question, items, option)
                              : items,
                          ),
                        )
                      }
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
              {result && <p className={styles.why}>{result.why[index]}</p>}
            </div>
          ))}
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
          <div className={styles.actions}>
            {result ? (
              <>
                <span role="status">
                  Верно {result.score} из {result.total}.
                </span>
                <button
                  type="button"
                  className={styles.primary}
                  onClick={() => setClosed(true)}
                >
                  Продолжить смену
                </button>
              </>
            ) : (
              <button
                type="button"
                className={styles.primary}
                disabled={!ready || sending}
                title={ready ? undefined : "Ответьте на все вопросы"}
                onClick={() => void submit()}
              >
                Проверить
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
