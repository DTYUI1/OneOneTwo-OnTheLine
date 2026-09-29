// Учебный экран результатов отделён от аутентичной карточки ДДС.
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../shared/api";
import { useSession } from "../shared/session";
import {
  criterionLabel,
  evaluationNote,
  formatScore,
  hasScore,
  readable,
} from "../teacher/console/model";
import styles from "./ResultsPage.module.css";
import { useHelpGuide } from "../shared/help/HelpProvider";
import { RESULTS_GUIDE } from "./help/topics";
import { useHelpEnabled } from "./help/useHelpEnabled";

export function ResultsPage() {
  useHelpGuide(useHelpEnabled() ? RESULTS_GUIDE : null);
  const { user, realtime } = useSession();
  const queries = useQueryClient();
  const results = useQuery({
    queryKey: ["evaluations", "own", user.id],
    queryFn: async () => {
      const { data, error } = await api.GET("/evaluations");
      if (!data)
        throw new Error(error?.message ?? "Не удалось загрузить результаты.");
      return data;
    },
  });
  const cards = useQuery({
    queryKey: ["cards"],
    queryFn: async () => {
      const { data, error } = await api.GET("/cards");
      if (!data)
        throw new Error(error?.message ?? "Не удалось загрузить карточки.");
      return data;
    },
  });
  useEffect(
    () =>
      realtime.subscribe((event) => {
        if (
          ["snapshot", "evaluation.partial", "evaluation.complete"].includes(
            event.type,
          )
        ) {
          void queries.invalidateQueries({
            queryKey: ["evaluations", "own", user.id],
          });
        }
      }),
    [realtime, queries, user.id],
  );

  return (
    <main className={styles.page} data-help="results-summary">
      <Link to="/arm">Вернуться в тренажёр</Link>
      <h1>Мои результаты</h1>
      <p>
        Итоговый балл учитывает решение преподавателя. Основания автоматической
        проверки сохранены ниже.
      </p>
      {results.isPending && <p role="status">Загружаем результаты…</p>}
      {results.isError && (
        <p role="alert">
          {results.error.message}{" "}
          <button onClick={() => void results.refetch()}>Повторить</button>
        </p>
      )}
      {cards.isError && (
        <p role="alert">
          Названия карточек недоступны. Результаты показаны по идентификаторам.
        </p>
      )}
      {results.data?.length === 0 && (
        <p>Результатов пока нет. Завершите назначенное задание.</p>
      )}
      {results.data?.map((result) => {
        const card = cards.data?.find((item) => item.id === result.card_id);
        const note = evaluationNote(result);
        return (
          <article key={result.id} className={styles.result}>
            <h2>Карточка {card?.source.number ?? result.card_id}</h2>
            {card && <p>{card.source.incident_class}</p>}
            <p>
              <strong>
                Итог:{" "}
                {hasScore(result) ? formatScore(result.total) : "не оценено"}
              </strong>
            </p>
            {note && <p role="status">{note}</p>}
            {result.teacher_comment && (
              <aside className={styles.feedback}>
                <strong>Комментарий преподавателя</strong>
                <p>{result.teacher_comment}</p>
              </aside>
            )}
            <div className={styles.scroll}>
              <table>
                <caption>Разбор выполнения</caption>
                <thead>
                  <tr>
                    <th>Критерий</th>
                    <th>Балл</th>
                    <th>Объяснение и факты</th>
                  </tr>
                </thead>
                <tbody>
                  {result.criteria.map((criterion) => (
                    <tr key={criterion.key}>
                      <th scope="row">
                        {criterionLabel(criterion.key)}
                        {criterion.critical && (
                          <span className={styles.critical}>
                            {" "}
                            · Критическая ошибка
                          </span>
                        )}
                      </th>
                      <td>
                        {hasScore(result) ? formatScore(criterion.score) : "—"}
                      </td>
                      <td>
                        <p>{readable(criterion.explanation)}</p>
                        <ul>
                          {criterion.evidence.map((evidence, index) => (
                            <li key={index}>{readable(evidence)}</li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
        );
      })}
    </main>
  );
}
