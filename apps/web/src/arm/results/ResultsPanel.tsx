// «Мои результаты» (T-031): закрытые карточки обучаемого по занятиям и разбор
// выбранной. Открывается поверх списка происшествий, как карточка.
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../shared/api";
import { useSession } from "../../shared/session";
import { formatDuration, type Service } from "../cardModel";
import { CardReview } from "./CardReview";
import { analysisRevision, useAttemptAnalyses } from "../useAnalysis";
import { checksPending } from "../../shared/aiProgress";
import {
  groupResults,
  isEmptyState,
  rowLabel,
  rowVerdict,
  summarize,
  type ResultRow,
} from "./resultsModel";
import styles from "./Results.module.css";

export function ResultsPanel({
  initialCardId,
  services,
  onClose,
}: {
  initialCardId: string | null;
  services: Service[];
  onClose: () => void;
}) {
  const queries = useQueryClient();
  const { realtime } = useSession();
  const [selectedId, setSelectedId] = useState<string | null>(initialCardId);

  const cards = useQuery({
    queryKey: ["cards"],
    queryFn: async () => {
      const { data, error } = await api.GET("/cards");
      if (!data) throw new Error(error?.message ?? "Нет связи с сервером.");
      return data;
    },
  });
  const evaluations = useQuery({
    queryKey: ["evaluations"],
    queryFn: async () => {
      const { data, error } = await api.GET("/evaluations");
      if (!data) throw new Error(error?.message ?? "Оценки недоступны.");
      return data;
    },
    // Запасной путь, если WS-событие о вердикте потерялось; ИИ-проверка начинается без
    // события — пока она идёт или ждёт, опрашиваем чаще.
    refetchInterval: (query) =>
      checksPending(query.state.data) ? 5_000 : 20_000,
  });
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: async () => {
      const { data, error } = await api.GET("/sessions");
      if (!data) throw new Error(error?.message ?? "Занятия недоступны.");
      return data;
    },
  });

  // Вердикт приходит после закрытия карточки, асинхронно: ws-events.md прямо
  // адресует evaluation.partial/complete результатам обучаемого.
  useEffect(
    () =>
      realtime.subscribe((event) => {
        if (event.type === "snapshot") {
          for (const key of ["cards", "evaluations", "sessions", "card-events"])
            void queries.invalidateQueries({ queryKey: [key] });
        }
        if (
          event.type === "evaluation.partial" ||
          event.type === "evaluation.complete"
        )
          void queries.invalidateQueries({ queryKey: ["evaluations"] });
        // Синхронизация часов и присутствие не меняют разборы попыток.
        // Иначе каждые пять секунд заново загружается весь архив результатов.
        if (
          event.type === "snapshot" ||
          event.type === "card.updated" ||
          event.type === "session.finished" ||
          event.type === "training.updated" ||
          event.type === "evaluation.partial" ||
          event.type === "evaluation.complete"
        )
          void queries.invalidateQueries({ queryKey: ["analysis"] });
      }),
    [realtime, queries],
  );

  const finished = new Set(
    (sessions.data ?? [])
      .filter((session) => session.status === "finished")
      .map((session) => session.id),
  );
  const demo = new Set(
    (sessions.data ?? [])
      .filter((session) => session.settings_snapshot.demo === true)
      .map((session) => session.id),
  );
  const groups = groupResults(
    cards.data ?? [],
    evaluations.data ?? [],
    finished,
    demo,
  );
  const rows = groups.flatMap((group) => group.rows);
  // Время попыток — из серверного разбора по методике и снимку своего занятия.
  const analysisResults = useAttemptAnalyses(
    rows.map((row) => ({
      cardId: row.card.id,
      evaluationId: row.evaluation?.id ?? null,
      evaluationVersion: row.evaluation?.version ?? null,
      evaluationRevision: analysisRevision(row.evaluation),
      effectiveTotal: row.evaluation?.total ?? null,
    })),
  );
  const analyses = analysisResults.byCard;
  const summary = summarize(groups, analyses);
  const listReady =
    cards.isSuccess && evaluations.isSuccess && sessions.isSuccess;
  const selected: ResultRow | null =
    rows.find((row) => row.card.id === selectedId) ?? rows[0] ?? null;
  const title = (id: string) =>
    sessions.data?.find((session) => session.id === id)?.title ?? "Занятие";

  return (
    <section className={styles.panel} aria-labelledby="results-title">
      <header className={styles.head} data-help="results-summary">
        <h2 id="results-title">Мои результаты</h2>
        {listReady ? (
          <p className={styles.counters}>
            закрыто карточек: {summary.closed} · оценено: {summary.scored} ·
            зачтено по текущим разборам: {summary.passed} из{" "}
            {summary.verdictsReady} · реакция в нормативе:{" "}
            {summary.reactionInNorm} из {summary.reactionKnown} с проверенным
            временем
            {summary.interrupted > 0 &&
              ` · прервано завершением занятия: ${summary.interrupted}`}
            {summary.withComment > 0 &&
              ` · с комментарием преподавателя: ${summary.withComment}`}
          </p>
        ) : (
          <p className={styles.counters}>Сводка загружается…</p>
        )}
        <button
          type="button"
          className={styles.close}
          onClick={onClose}
          aria-label="Закрыть результаты"
        >
          ✕
        </button>
      </header>

      {(cards.isPending || evaluations.isPending || sessions.isPending) && (
        <p className={styles.empty}>Загружаем результаты…</p>
      )}
      {(cards.isError || evaluations.isError || sessions.isError) && (
        <div role="alert" className={styles.empty}>
          <p className={styles.muted}>
            Не удалось загрузить результаты. Проверьте связь.
          </p>
          <button
            type="button"
            onClick={() => {
              void cards.refetch();
              void evaluations.refetch();
              void sessions.refetch();
            }}
          >
            Повторить
          </button>
        </div>
      )}
      {listReady &&
        isEmptyState(cards.isSuccess, evaluations.isSuccess, rows.length) && (
          <p className={styles.empty}>
            Закрытых карточек пока нет. Разбор появится, когда вы доведёте
            карточку до «Работы завершены» или «Отказ от выполнения работ».
          </p>
        )}

      {listReady && analysisResults.failed.size > 0 && (
        <p role="alert" className={styles.empty}>
          Не удалось загрузить разбор карточек: {analysisResults.failed.size}.
          Баллы этих карточек не показаны.{" "}
          <button
            type="button"
            onClick={() => void analysisResults.retryFailed()}
          >
            Повторить загрузку разбора
          </button>
        </p>
      )}

      {listReady && rows.length > 0 && (
        <div className={styles.body}>
          <nav
            className={styles.list}
            aria-label="Закрытые карточки"
            data-help="results-list"
          >
            {groups.map((group) => (
              <div key={group.sessionId}>
                <h3 className={styles.groupBar}>{title(group.sessionId)}</h3>
                <ul>
                  {group.rows.map((row) => {
                    const analysis = analyses.get(row.card.id);
                    const timing = analysis?.timing;
                    const verdict = rowVerdict(row, analysis);
                    const reaction =
                      timing?.reaction_s == null
                        ? null
                        : Math.round(timing.reaction_s);
                    const late = timing?.reaction_overdue === true;
                    return (
                      <li key={row.card.id}>
                        <button
                          type="button"
                          className={styles.item}
                          aria-current={
                            row.card.id === selected?.card.id
                              ? "true"
                              : undefined
                          }
                          onClick={() => setSelectedId(row.card.id)}
                        >
                          <span className={styles.itemTitle}>
                            {row.card.source.number} ·{" "}
                            {row.card.source.incident_class}
                          </span>
                          <span className={styles.itemMeta}>
                            <span
                              className={
                                verdict?.passed === false
                                  ? styles.bad
                                  : undefined
                              }
                            >
                              {analysisResults.failed.has(row.card.id)
                                ? "Разбор не загрузился — повторите загрузку"
                                : rowLabel(row, analysis)}
                            </span>
                            <span className={late ? styles.bad : undefined}>
                              реакция{" "}
                              {reaction === null
                                ? "—"
                                : formatDuration(reaction)}
                              {reaction !== null &&
                                timing?.reaction_overdue === null &&
                                " (норматив не проверен)"}
                            </span>
                            {row.evaluation?.teacher_comment.trim() && (
                              <span className={styles.hasComment}>
                                есть комментарий
                              </span>
                            )}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>
          {selected && (
            <CardReview
              key={selected.card.id}
              row={selected}
              services={services}
            />
          )}
        </div>
      )}
    </section>
  );
}
