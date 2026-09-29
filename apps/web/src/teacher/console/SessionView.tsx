// Выбранное занятие: тёмная полоса заголовка с управлением, как «Происшествие 101»
// в карточке АРМ, и вкладки-плитки, как панель служб внизу карточки.
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, csrfToken } from "../../shared/api";
import {
  SESSION_STATUS_LABELS,
  defaultTab,
  startBlockers,
  verdictsForSession,
  type SessionTab,
} from "./model";
import {
  useIssuedAssignments,
  useCards,
  useEvaluations,
  useSession,
} from "./useConsoleData";
import { HandoutTab } from "./HandoutTab";
import { LiveTab } from "./LiveTab";
import { ReportTab, type LessonPrefill } from "./ReportTab";
import { VerdictFeed } from "./VerdictFeed";
import { SessionClock } from "./SessionClock";
import { onTabListKey } from "../tabKeys";
import styles from "./Console.module.css";

const TAB_LABELS: Record<SessionTab, string> = {
  handout: "Состав и раздача",
  live: "Ход занятия",
  verdicts: "Вердикты",
  report: "Отчёт",
};

export function SessionView({
  sessionId,
  tab,
  onTab,
  onNewLesson,
}: {
  sessionId: string;
  /** Открытая вкладка — часть экрана кабинета, по ней ходят «Назад» и «Вперёд». */
  tab?: SessionTab;
  onTab: (tab: SessionTab) => void;
  onNewLesson?: (prefill: LessonPrefill) => void;
}) {
  const queries = useQueryClient();
  const session = useSession(sessionId);
  const assignments = useIssuedAssignments(sessionId);
  const cards = useCards();
  const evaluations = useEvaluations();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // При переходе к другому занятию сообщения прошлого не показываем.
  useEffect(() => {
    setError("");
    setNotice("");
  }, [sessionId]);

  const control = useMutation({
    mutationFn: async (action: "start" | "finish") => {
      const path =
        action === "start" ? "/sessions/{id}/start" : "/sessions/{id}/finish";
      const { data, error } = await api.POST(path, {
        params: {
          path: { id: sessionId },
          header: { "X-CSRF-Token": csrfToken() },
        },
      });
      if (!data) throw new Error(error?.message ?? "Действие не выполнено.");
      return data;
    },
    onSuccess: async (updated) => {
      setError("");
      setNotice(
        updated.status === "running"
          ? "Занятие запущено."
          : "Занятие завершено.",
      );
      onTab(defaultTab(updated.status));
      await queries.invalidateQueries({ queryKey: ["session", sessionId] });
      await queries.invalidateQueries({ queryKey: ["sessions"] });
      await queries.invalidateQueries({ queryKey: ["report", sessionId] });
    },
    onError: (cause: Error) => setError(cause.message),
  });

  async function downloadCsv() {
    // CSV формирует backend: пересчитывать оценки в браузере нельзя (ответ капитана §2).
    try {
      const { data, error, response } = await api.GET(
        "/reports/session/{id}/csv",
        {
          params: { path: { id: sessionId } },
          parseAs: "blob",
        },
      );
      if (!data || error) {
        // 401/403 здесь обычно значит, что в этом же браузере вошли под другой
        // учётной записью: cookie сессии одна на профиль, вкладка об этом не знает.
        setError(
          response.status === 401 || response.status === 403
            ? "Отчёт не выдан: сессия принадлежит другой учётной записи. Войдите преподавателем заново."
            : `Не удалось выгрузить CSV (ошибка ${response.status}).`,
        );
        return;
      }
      const url = URL.createObjectURL(data);
      const link = document.createElement("a");
      link.href = url;
      link.download = `report-${sessionId}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("Не удалось выгрузить CSV: проверьте соединение и повторите.");
    }
  }

  if (session.isPending)
    return <p className={styles.placeholder}>Загружаем занятие…</p>;
  if (!session.data)
    return (
      <p role="alert" className={styles.placeholder}>
        Занятие недоступно.
      </p>
    );

  const status = session.data.status;
  const current = tab ?? defaultTab(status);
  const blockers =
    status === "draft"
      ? startBlockers(session.data, assignments.data ?? [])
      : [];
  const verdictCount = verdictsForSession(
    evaluations.data ?? [],
    cards.data ?? [],
    sessionId,
  ).length;

  return (
    <section className={styles.view} aria-labelledby="session-title">
      <header className={styles.titleBar} data-help="teacher-session">
        <div>
          <h2 id="session-title">{session.data.title}</h2>
          <span className={styles[`status_${status}`]}>
            {SESSION_STATUS_LABELS[status]}
          </span>
          <SessionClock session={session.data} className={styles.clock} />
        </div>
        <div className={styles.titleActions}>
          {status === "draft" && (
            <button
              type="button"
              className={styles.primary}
              disabled={blockers.length > 0 || control.isPending}
              title={blockers.join(" ")}
              onClick={() => control.mutate("start")}
            >
              Начать занятие
            </button>
          )}
          {status === "running" && (
            <button
              type="button"
              className={styles.dark}
              disabled={control.isPending}
              onClick={() => control.mutate("finish")}
            >
              Завершить
            </button>
          )}
          {status !== "draft" && (
            <button
              type="button"
              className={styles.plain}
              onClick={() => void downloadCsv()}
            >
              Отчёт CSV
            </button>
          )}
        </div>
      </header>

      {blockers.length > 0 && (
        <ul className={styles.blockers} role="status">
          {blockers.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className={styles.message}>
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className={styles.message}>
          {notice}
        </p>
      )}

      <div
        className={styles.tabs}
        role="tablist"
        aria-label="Разделы занятия"
        data-help="teacher-tabs"
        onKeyDown={onTabListKey}
      >
        {(Object.keys(TAB_LABELS) as SessionTab[]).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={current === key}
            className={styles.tab}
            onClick={() => onTab(key)}
          >
            {TAB_LABELS[key]}
            {key === "verdicts" && verdictCount > 0 && (
              <span className={styles.tabCount}>{verdictCount}</span>
            )}
          </button>
        ))}
      </div>

      <div
        className={styles.tabBody}
        role="tabpanel"
        data-help={`teacher-${current}`}
      >
        {current === "handout" && <HandoutTab session={session.data} />}
        {current === "live" && <LiveTab session={session.data} />}
        {current === "verdicts" && <VerdictFeed session={session.data} />}
        {current === "report" && (
          <ReportTab session={session.data} onNewLesson={onNewLesson} />
        )}
      </div>
    </section>
  );
}
