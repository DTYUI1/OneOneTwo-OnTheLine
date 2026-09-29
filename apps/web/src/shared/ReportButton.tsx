// «Сообщить об ошибке» — кнопка шапки для всех ролей (28.09). Сообщение хранится в
// базе тренажёра, поэтому работает без интернета; читает администратор в разделе
// «Сообщения об ошибках». Экран подставляется сам: человеку не нужно его описывать.
import { useRef, useState, type FormEvent } from "react";
import type { components } from "../api-client/schema";
import { api, csrfToken } from "./api";
import styles from "./ReportButton.module.css";

type Category = components["schemas"]["ProblemReportInput"]["category"];

export const REPORT_CATEGORIES: Record<Category, string> = {
  bug: "Что-то не работает",
  evaluation: "Оценка кажется неверной",
  unclear: "Непонятно, что делать",
  other: "Другое",
};

const MAX_TEXT = 2000;
const MAX_PAGE = 300;

type Phase = "edit" | "sending" | "sent";

export function ReportButton() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [category, setCategory] = useState<Category>("bug");
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>("edit");
  const [error, setError] = useState("");

  function open() {
    // Отправленное сообщение не держим на экране: новое окно — новое сообщение.
    if (phase === "sent") setPhase("edit");
    setError("");
    dialog.current?.showModal();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) {
      setError("Опишите, что случилось.");
      return;
    }
    setPhase("sending");
    setError("");
    try {
      const { data, error: failure } = await api.POST("/problem-reports", {
        params: { header: { "X-CSRF-Token": csrfToken() } },
        body: {
          category,
          text: text.trim().slice(0, MAX_TEXT),
          page: (window.location.pathname + window.location.search).slice(
            0,
            MAX_PAGE,
          ),
        },
      });
      if (!data) {
        setPhase("edit");
        setError(failure?.message ?? "Сообщение не отправлено. Повторите.");
        return;
      }
      setText("");
      setCategory("bug");
      setPhase("sent");
    } catch {
      // Текст остаётся в поле: повторить можно, ничего не набирая заново.
      setPhase("edit");
      setError("Нет связи с сервером. Текст сохранён — повторите позже.");
    }
  }

  return (
    <>
      <button type="button" onClick={open}>
        Сообщить об ошибке
      </button>
      <dialog
        ref={dialog}
        className={styles.dialog}
        aria-labelledby="report-heading"
      >
        <header className={styles.head}>
          <h2 id="report-heading">Сообщить об ошибке</h2>
          <button type="button" onClick={() => dialog.current?.close()}>
            Закрыть
          </button>
        </header>
        {phase === "sent" ? (
          <div className={styles.body}>
            <p role="status" className={styles.done}>
              Спасибо! Сообщение получит администратор тренажёра.
            </p>
            <div className={styles.actions}>
              <button type="button" onClick={() => setPhase("edit")}>
                Написать ещё
              </button>
              <button type="button" onClick={() => dialog.current?.close()}>
                Закрыть
              </button>
            </div>
          </div>
        ) : (
          <form
            className={styles.body}
            onSubmit={(event) => void submit(event)}
          >
            <p className={styles.lead}>
              Опишите, что пошло не так. Экран, на котором вы сейчас, мы
              приложим сами.
            </p>
            <fieldset className={styles.kinds}>
              <legend>Что случилось</legend>
              {(Object.keys(REPORT_CATEGORIES) as Category[]).map((key) => (
                <label key={key}>
                  <input
                    type="radio"
                    name="report-category"
                    value={key}
                    checked={category === key}
                    onChange={() => setCategory(key)}
                  />
                  {REPORT_CATEGORIES[key]}
                </label>
              ))}
            </fieldset>
            <label className={styles.text}>
              Описание
              <textarea
                value={text}
                maxLength={MAX_TEXT}
                rows={5}
                onChange={(event) => setText(event.target.value)}
              />
            </label>
            {error && (
              <p role="alert" className={styles.error}>
                {error}
              </p>
            )}
            <div className={styles.actions}>
              <button type="submit" disabled={phase === "sending"}>
                {phase === "sending" ? "Отправляем…" : "Отправить"}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </>
  );
}
