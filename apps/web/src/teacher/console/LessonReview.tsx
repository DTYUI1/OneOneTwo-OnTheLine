// Итоги занятия (TC-13, contracts/lesson-review.md): оценка ИИ и итоговая, отзыв ученику
// «было → стало», тепловая карта «ученик × критерий» с советом группе и «Выдать отчёт».
// Операции вне openapi.json — fetch, как в ходе занятия.
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { csrfToken } from "../../shared/api";
import { criterionLabel } from "./model";
import styles from "./Console.module.css";

interface TraineeReview {
  readonly user_id: string;
  readonly full_name: string;
  readonly ai_total: number | null;
  readonly final_total: number | null;
  readonly draft: string;
  readonly text: string | null;
  readonly released_at: string | null;
}

interface Review {
  readonly trainees: readonly TraineeReview[];
  readonly heatmap: {
    readonly criteria: readonly string[];
    readonly rows: readonly {
      readonly user_id: string;
      readonly full_name: string;
      readonly cells: Readonly<Record<string, number | null>>;
    }[];
    readonly advice: readonly string[];
  };
}

const percent = (value: number | null) =>
  value === null ? "—" : String(Math.round(value * 100));

/** «оценка ИИ 64 → итоговая 75»; без правки преподавателя — одно число. */
export function totalsLine(item: TraineeReview): string {
  if (item.final_total === null) return "не оценивалось";
  if (percent(item.ai_total) === percent(item.final_total))
    return `оценка ${percent(item.final_total)}`;
  return `оценка ИИ ${percent(item.ai_total)} → итоговая ${percent(item.final_total)}`;
}

async function send(path: string, method: string, body?: unknown) {
  const response = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(error?.message ?? "Нет связи с сервером.");
  }
  return response.json();
}

function FeedbackRow({
  sessionId,
  item,
}: {
  sessionId: string;
  item: TraineeReview;
}) {
  const queries = useQueryClient();
  const [text, setText] = useState(item.text ?? item.draft);
  const released = item.released_at !== null;
  const save = useMutation({
    mutationFn: () =>
      send(`/api/sessions/${sessionId}/feedback/${item.user_id}`, "PUT", {
        text,
      }),
    onSuccess: () =>
      queries.invalidateQueries({ queryKey: ["review", sessionId] }),
  });
  const changed = text.trim() !== (item.text ?? item.draft);
  return (
    <details className={styles.reviewRow} data-review-row>
      <summary>
        {item.full_name} — {totalsLine(item)}
        {released ? ", выдан" : ""}
      </summary>
      <div className={styles.field}>
        <label>
          Отзыв ученику
          <textarea
            rows={4}
            value={text}
            readOnly={released}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        {item.text !== null && item.text !== item.draft && (
          <p className={styles.muted} data-review-was>
            Было: {item.draft}
          </p>
        )}
        {!released && (
          <div>
            <button
              type="button"
              className={styles.plain}
              disabled={!changed || !text.trim() || save.isPending}
              onClick={() => save.mutate()}
            >
              Сохранить отзыв
            </button>{" "}
            {save.isError && <span role="alert">{save.error.message}</span>}
            {save.isSuccess && !changed && <span>Отзыв сохранён</span>}
          </div>
        )}
      </div>
    </details>
  );
}

function cellStyle(value: number | null) {
  if (value === null) return undefined;
  if (value < 0.5)
    return {
      background: "color-mix(in srgb, var(--color-danger) 22%, white)",
    };
  if (value < 1)
    return { background: "color-mix(in srgb, var(--color-active) 12%, white)" };
  return undefined;
}

export function LessonReview({ sessionId }: { sessionId: string }) {
  const queries = useQueryClient();
  const root = useRef<HTMLDivElement>(null);
  const review = useQuery({
    queryKey: ["review", sessionId],
    queryFn: async (): Promise<Review> =>
      send(`/api/sessions/${sessionId}/review`, "GET"),
  });
  const release = useMutation({
    mutationFn: () =>
      send(`/api/sessions/${sessionId}/feedback/release`, "POST", {}),
    onSuccess: () =>
      queries.invalidateQueries({ queryKey: ["review", sessionId] }),
  });
  // Перед печатью все строки раскрываются, чтобы отчёт на бумаге был полным.
  useEffect(() => {
    const open = () =>
      root.current
        ?.querySelectorAll("details")
        .forEach((node) => node.setAttribute("open", ""));
    window.addEventListener("beforeprint", open);
    return () => window.removeEventListener("beforeprint", open);
  }, []);

  if (review.isPending)
    return <p className={styles.placeholder}>Собираем итоги…</p>;
  if (review.isError)
    return (
      <p role="alert" className={styles.placeholder}>
        Итоги не загрузились.
      </p>
    );
  const { trainees, heatmap } = review.data;
  const waiting = trainees.filter((item) => item.released_at === null).length;
  return (
    <div className={styles.panel} ref={root}>
      <h3 className={styles.panelTitle}>Итоги и отзывы</h3>
      {trainees.map((item) => (
        <FeedbackRow
          key={`${item.user_id}:${item.text ?? ""}`}
          sessionId={sessionId}
          item={item}
        />
      ))}
      <p>
        <button
          type="button"
          className={styles.primary}
          disabled={waiting === 0 || release.isPending}
          onClick={() => release.mutate()}
        >
          Выдать отчёт
        </button>{" "}
        <span className={styles.muted}>
          {waiting === 0
            ? "Отчёт выдан всем."
            : `Ученики увидят отчёт после выдачи: ${waiting}.`}
        </span>
      </p>
      {heatmap.criteria.length > 0 && (
        <details className={styles.reviewRow} open>
          <summary>Тепловая карта: ученик × критерий</summary>
          <div className={styles.tableScroll}>
            <table className={styles.table} data-heatmap>
              <thead>
                <tr>
                  <th>Ученик</th>
                  {heatmap.criteria.map((key) => (
                    <th key={key}>{criterionLabel(key)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {heatmap.rows.map((row) => (
                  <tr key={row.user_id}>
                    <td>{row.full_name}</td>
                    {heatmap.criteria.map((key) => (
                      <td key={key} style={cellStyle(row.cells[key] ?? null)}>
                        {percent(row.cells[key] ?? null)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {heatmap.advice.map((line) => (
            <p key={line} data-group-advice>
              {line}
            </p>
          ))}
        </details>
      )}
    </div>
  );
}
