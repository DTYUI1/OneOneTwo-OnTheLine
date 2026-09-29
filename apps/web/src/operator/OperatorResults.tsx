// Экран «Результаты тренировок 112» (просьба капитана 29.09): сюда ведёт выход из 112.
// Слева — сводка и попытки (новые сверху), справа — разбор выбранной попытки, как в окне
// «Результат попытки»: баллы с пояснениями, эталонный порядок, время шагов и лента звонка.
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useSession } from "../shared/session";
import { OPERATOR_DATA as data } from "./data";
import { AttemptScore, StepTimes, Timeline, formatDate } from "./Review";
import { exitTarget, summarize } from "./results";
import { fetchAttempt, fetchAttempts } from "./save";
import styles from "./OperatorResults.module.css";

export function OperatorResults() {
  const { user } = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const attempts = useQuery({
    queryKey: ["operator-attempts", user.id],
    queryFn: fetchAttempts,
  });
  const list = attempts.data ?? [];
  const selectedId = params.get("attempt") ?? list[0]?.id ?? null;
  const detail = useQuery({
    queryKey: ["operator-attempt", selectedId],
    queryFn: () => fetchAttempt(selectedId!),
    enabled: selectedId !== null,
  });
  const summary = summarize(list);
  const scenario = data.scenarios.find(
    (item) => item.id === detail.data?.scenario_id,
  );
  const close = () => {
    const target = exitTarget(user.role);
    navigate(target.to, { state: target.state });
  };

  return (
    <main className={styles.page} aria-labelledby="operator-results-title">
      <header className={styles.header}>
        <h1 id="operator-results-title">
          Результаты тренировок «Оператор 112»
        </h1>
        <button
          type="button"
          className={styles.primary}
          onClick={() => navigate("/operator")}
        >
          Новый звонок
        </button>
        <button
          type="button"
          className={styles.close}
          aria-label="Закрыть результаты"
          title="Закрыть — к выбору обучения"
          onClick={close}
        >
          ×
        </button>
      </header>

      {attempts.isPending && (
        <p className={styles.state} role="status">
          Загружаем результаты…
        </p>
      )}
      {attempts.isError && (
        <p className={styles.state} role="alert">
          Не удалось загрузить результаты.{" "}
          <button type="button" onClick={() => void attempts.refetch()}>
            Повторить
          </button>
        </p>
      )}
      {attempts.isSuccess && list.length === 0 && (
        <p className={styles.state}>
          Попыток пока нет. Нажмите «Новый звонок», примите вызов и сохраните
          карточку — результат появится здесь.
        </p>
      )}

      {list.length > 0 && (
        <div className={styles.body}>
          <aside className={styles.side} aria-label="Сводка и попытки">
            <dl className={styles.totals}>
              <div>
                <dt>Попыток</dt>
                <dd>{summary.count}</dd>
              </div>
              <div>
                <dt>Средний балл</dt>
                <dd>{summary.average}%</dd>
              </div>
              <div>
                <dt>Лучший</dt>
                <dd>{summary.best}%</dd>
              </div>
            </dl>
            <table className={styles.calls}>
              <caption>По звонкам</caption>
              <thead>
                <tr>
                  <th scope="col">Звонок</th>
                  <th scope="col">Раз</th>
                  <th scope="col">Лучший</th>
                  <th scope="col">Последний</th>
                </tr>
              </thead>
              <tbody>
                {summary.calls.map((call) => (
                  <tr key={call.scenarioId}>
                    <th scope="row">{call.title}</th>
                    <td>{call.count}</td>
                    <td>
                      {call.best} / {call.max}
                    </td>
                    <td>
                      {call.last} / {call.max}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h2 className={styles.listTitle}>Попытки</h2>
            <ul className={styles.attempts}>
              {list.map((attempt) => (
                <li key={attempt.id}>
                  <button
                    type="button"
                    aria-current={attempt.id === selectedId || undefined}
                    onClick={() =>
                      setParams({ attempt: attempt.id }, { replace: true })
                    }
                  >
                    <span>{attempt.scenario_title}</span>
                    <time dateTime={attempt.created_at}>
                      {formatDate(attempt.created_at)}
                    </time>
                    <strong>
                      {attempt.total} / {attempt.max_total}
                    </strong>
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          <section
            className={styles.score}
            tabIndex={0}
            aria-label="Баллы попытки"
          >
            {detail.isPending && <p role="status">Загружаем попытку…</p>}
            {detail.isError && (
              <p role="alert">Не удалось загрузить попытку.</p>
            )}
            {detail.data && (
              <>
                <h2>
                  {detail.data.scenario_title}
                  <small>{formatDate(detail.data.created_at)}</small>
                </h2>
                <AttemptScore result={detail.data} scenario={scenario} />
              </>
            )}
          </section>
          <section
            className={styles.review}
            tabIndex={0}
            aria-labelledby="operator-results-review"
          >
            <h2 id="operator-results-review">Разбор звонка</h2>
            {detail.data && (
              <>
                <StepTimes journal={detail.data.journal} />
                <Timeline journal={detail.data.journal} />
              </>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
