// Кабинет преподавателя. Раскладка — в языке боевого АРМ, чтобы экран был знаком
// преподавателям (ответ заказчика 21.09, docs/C08_customer_2026-09-21.md#ui-scope):
// светлая шапка с крупным заголовком, слева стальное поле со списком занятий,
// справа выбранное занятие с тёмной полосой заголовка и вкладками-плитками.
import { useState } from "react";
import { SessionForm } from "./console/SessionForm";
import { SessionList, type ConsoleView } from "./console/SessionList";
import { SessionView } from "./console/SessionView";
import type { LessonPrefill } from "./console/ReportTab";
import { FinishPrompt } from "./console/FinishPrompt";
import { latestRunning } from "./console/lessonClock";
import { useSessions } from "./console/useConsoleData";
import { useTeacherUpdates } from "./console/useTeacherUpdates";
import { ScenarioStudio } from "./studio/ScenarioStudio";
import { MaterialsPanel } from "./materials/MaterialsPanel";
import { useViewHistory } from "./viewHistory";
import { useHelpGuide } from "../shared/help/HelpProvider";
import { TEACHER_GUIDE } from "./help/topics";
import styles from "./TeacherPage.module.css";

export function TeacherPage() {
  useTeacherUpdates();
  const sessions = useSessions();
  // Открытый раздел переживает перезагрузку страницы.
  const history = useViewHistory();
  const chosen = history.view;

  // Пока преподаватель ничего не выбрал, открываем идущее занятие — за ним и следят.
  const running = latestRunning(sessions.data ?? []);
  const view: ConsoleView =
    chosen ??
    (running ? { kind: "session", id: running.id } : { kind: "empty" });

  const [prefill, setPrefill] = useState<LessonPrefill | null>(null);

  // Новый раздел открываем с начала: после длинного отчёта не остаёмся внизу.
  const open = history.open;
  useHelpGuide(TEACHER_GUIDE);

  const counts = (sessions.data ?? []).reduce(
    (acc, session) => ({ ...acc, [session.status]: acc[session.status] + 1 }),
    { draft: 0, running: 0, finished: 0 },
  );

  return (
    <main className={styles.page}>
      <header className={styles.top}>
        <h1>Кабинет преподавателя</h1>
        <nav
          className={styles.navigation}
          aria-label="Переходы по кабинету"
          data-help="teacher-navigation"
        >
          <button disabled={!history.canBack} onClick={history.back}>
            Назад
          </button>
          <button disabled={!history.canForward} onClick={history.forward}>
            Вперёд
          </button>
          <button onClick={() => open({ kind: "empty" })}>На главную</button>
        </nav>
        <p className={styles.summary} data-help="teacher-summary">
          {sessions.data
            ? `идёт занятий: ${counts.running} · черновиков: ${counts.draft} · завершено: ${counts.finished}`
            : "загружаем занятия…"}
        </p>
      </header>

      <div className={styles.layout}>
        <SessionList view={view} onSelect={open} />
        <div className={styles.content}>
          {view.kind === "empty" && (
            <div className={styles.empty} data-help="teacher-empty">
              <h2>Занятие не выбрано</h2>
              <p>
                Выберите занятие слева или создайте новое. Подготовьте состав и
                раздайте сценарии. После начала занятия следите за работой
                обучаемых и проверяйте результаты.
              </p>
            </div>
          )}
          {view.kind === "new" && (
            <div data-help="teacher-new">
              <SessionForm
                prefill={prefill}
                onCreated={(id) => {
                  setPrefill(null);
                  open({ kind: "session", id });
                }}
              />
            </div>
          )}
          {view.kind === "catalog" && <ScenarioStudio />}
          {view.kind === "materials" && (
            <div data-help="teacher-materials">
              <MaterialsPanel />
            </div>
          )}
          {view.kind === "session" && (
            <SessionView
              key={view.id}
              sessionId={view.id}
              tab={view.tab}
              onTab={(tab) => open({ kind: "session", id: view.id, tab })}
              onNewLesson={(next) => {
                setPrefill(next);
                open({ kind: "new" });
              }}
            />
          )}
        </div>
      </div>
      <FinishPrompt sessions={sessions.data ?? []} />
    </main>
  );
}
