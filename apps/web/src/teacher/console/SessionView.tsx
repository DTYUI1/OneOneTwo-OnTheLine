// Выбранное занятие: тёмная полоса заголовка с управлением, как «Происшествие 101»
// в карточке АРМ, и вкладки-плитки, как панель служб внизу карточки.
// «Начать занятие» — не в шапке, а рядом с кнопкой выдачи (docs/dds_gameplay.md §9).
import { useEffect, useState } from "react";
import {
  useIsMutating,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
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
import { AIResourceDialog } from "./AIResourceDialog";
import { onTabListKey } from "../tabKeys";
import { DeleteDraftButton } from "../../shared/DeleteDraftButton";
import styles from "./Console.module.css";

const TAB_LABELS: Record<SessionTab, string> = {
  handout: "Состав и раздача",
  live: "Ход занятия",
  verdicts: "Оценки",
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
  const savingNorms = useIsMutating({
    mutationKey: ["session-norms", sessionId],
  });
  const session = useSession(sessionId);
  const assignments = useIssuedAssignments(sessionId);
  const cards = useCards();
  const evaluations = useEvaluations();
  const [error, setError] = useState("");
  const [deleted, setDeleted] = useState(false);
  const [notice, setNotice] = useState("");
  const [warning, setWarning] = useState(false);
  const [checking, setChecking] = useState(false);

  // При переходе к другому занятию сообщения прошлого не показываем.
  useEffect(() => {
    setError("");
    setNotice("");
    setDeleted(false);
  }, [sessionId]);
  useEffect(() => {
    if (session.data?.ai_preparation?.state === "ready") {
      void queries.invalidateQueries({
        queryKey: ["assignment-batches", sessionId],
      });
      void queries.invalidateQueries({ queryKey: ["scenarios"] });
    }
  }, [session.data?.ai_preparation?.state, sessionId, queries]);

  const control = useMutation({
    mutationFn: async ({
      action,
      mode,
    }: {
      action: "start" | "finish";
      mode?: "now" | "wait" | "cancel";
    }) => {
      const options = {
        params: {
          path: { id: sessionId },
          header: { "X-CSRF-Token": csrfToken() },
        },
      };
      const { data, error } =
        action === "start"
          ? await api.POST("/sessions/{id}/start", {
              ...options,
              body: mode ? { mode } : undefined,
            })
          : await api.POST("/sessions/{id}/finish", options);
      if (error?.code === "ai_generation_busy") setWarning(true);
      if (!data) throw new Error(error?.message ?? "Действие не выполнено.");
      return data;
    },
    onSuccess: async (updated) => {
      setError("");
      setNotice(
        updated.status === "running"
          ? "Занятие запущено."
          : updated.status === "finished"
            ? "Занятие завершено."
            : updated.start_pending
              ? "Ожидаем готовности генерации. Занятие ещё не началось."
              : "Ожидание запуска отменено.",
      );
      onTab(defaultTab(updated.status));
      await queries.invalidateQueries({ queryKey: ["session", sessionId] });
      await queries.invalidateQueries({ queryKey: ["sessions"] });
      await queries.invalidateQueries({ queryKey: ["report", sessionId] });
    },
    onError: (cause: Error) => setError(cause.message),
  });

  async function requestStart() {
    setChecking(true);
    setError("");
    try {
      const { data, error } = await api.GET("/ai/resource");
      if (!data)
        throw new Error(error?.message ?? "Не удалось проверить состояние ИИ.");
      if (data.local_ai && data.generation_running) setWarning(true);
      else control.mutate({ action: "start" });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось проверить состояние ИИ.",
      );
    } finally {
      setChecking(false);
    }
  }

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

  if (deleted)
    return (
      <p role="status">Черновик удалён. Выберите другое занятие в списке.</p>
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
      {warning && (
        <AIResourceDialog
          action="start"
          onChoose={(choice) => {
            setWarning(false);
            if (choice !== "cancel")
              control.mutate({ action: "start", mode: choice });
          }}
        />
      )}
      <header className={styles.titleBar} data-help="teacher-session">
        <div>
          <h2 id="session-title">{session.data.title}</h2>
          <span className={styles[`status_${status}`]}>
            {status === "draft" && session.data.ai_preparation
              ? session.data.ai_preparation.state === "ready"
                ? "Готово к началу"
                : session.data.ai_preparation.state === "cancelled"
                  ? "Подбор остановлен"
                  : "Подготовка"
              : SESSION_STATUS_LABELS[status]}
          </span>
          <SessionClock session={session.data} className={styles.clock} />
        </div>
        <div className={styles.titleActions}>
          {status === "draft" && (
            <DeleteDraftButton
              id={sessionId}
              kind="session"
              onDeleted={() => setDeleted(true)}
            />
          )}
          {status === "running" && (
            <button
              type="button"
              className={styles.dark}
              disabled={control.isPending}
              onClick={() => control.mutate({ action: "finish" })}
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
      {session.data.start_pending && (
        <p role="status" className={styles.message}>
          Ожидаем готовности генерации. Занятие ещё не началось; нормативы не
          идут. Запуск продолжится без открытой вкладки.{" "}
          <button
            type="button"
            className={styles.plain}
            disabled={control.isPending}
            onClick={() => control.mutate({ action: "start", mode: "cancel" })}
          >
            Отменить ожидание
          </button>
        </p>
      )}
      {session.data.start_error && (
        <p role="alert" className={styles.message}>
          {session.data.start_error}
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
        {current === "handout" && (
          <HandoutTab
            session={session.data}
            start={
              status === "draft"
                ? {
                    blockers,
                    pending:
                      control.isPending ||
                      savingNorms > 0 ||
                      checking ||
                      warning ||
                      Boolean(session.data.start_pending),
                    onStart: () => void requestStart(),
                  }
                : undefined
            }
          />
        )}
        {current === "live" && <LiveTab session={session.data} />}
        {current === "verdicts" && <VerdictFeed session={session.data} />}
        {current === "report" && (
          <ReportTab
            key={sessionId}
            session={session.data}
            onNewLesson={onNewLesson}
          />
        )}
      </div>
    </section>
  );
}
