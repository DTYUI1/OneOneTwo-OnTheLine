// Левая колонка пульта: занятия по группам и переходы к созданию и каталогу.
// Раскладка повторяет «Список происшествий» АРМ — стальное поле, белый заголовок.
import { STUDIO_SECTIONS, type StudioSection } from "../studio/sections";
import { useEffect, useState } from "react";
import { SESSION_STATUS_LABELS, sortSessions, type SessionTab } from "./model";
import { useScenarios, useSessions } from "./useConsoleData";
import styles from "./Console.module.css";

export type ConsoleView =
  | { kind: "empty" }
  | { kind: "new" }
  | { kind: "catalog"; section?: StudioSection }
  | { kind: "materials" }
  | { kind: "session"; id: string; tab?: SessionTab };

export function SessionList({
  view,
  onSelect,
}: {
  view: ConsoleView;
  onSelect: (view: ConsoleView) => void;
}) {
  const [studioExpanded, setStudioExpanded] = useState(view.kind === "catalog");
  const sessions = useSessions();
  const scenarios = useScenarios();
  const [showDrafts, setShowDrafts] = useState(false);
  const [showFinished, setShowFinished] = useState(false);
  const [finishedSearch, setFinishedSearch] = useState("");

  const sorted = sortSessions(sessions.data ?? []);
  const finished = sorted.filter((session) => session.status === "finished");
  const search = finishedSearch.trim().toLocaleLowerCase("ru-RU");
  const matchingFinished = finished.filter((session) =>
    session.title.toLocaleLowerCase("ru-RU").includes(search),
  );
  const drafts = sorted.filter((session) => session.status === "draft");
  const running = sorted.filter((session) => session.status === "running");
  const selectedId = view.kind === "session" ? view.id : null;
  const selectedStatus = sorted.find(
    (session) => session.id === selectedId,
  )?.status;
  useEffect(() => {
    if (selectedStatus === "draft") setShowDrafts(true);
    if (selectedStatus === "finished") setShowFinished(true);
  }, [selectedId, selectedStatus]);

  const sessionRows = (items: typeof sorted) => (
    <ul className={styles.sessionList}>
      {items.map((session) => (
        <li key={session.id}>
          <button
            type="button"
            className={styles.sessionItem}
            aria-current={session.id === selectedId ? "true" : undefined}
            onClick={() => onSelect({ kind: "session", id: session.id })}
          >
            <span className={styles.sessionTitle}>{session.title}</span>
            <span className={styles.sessionMeta}>
              <span className={styles[`status_${session.status}`]}>
                {SESSION_STATUS_LABELS[session.status]}
              </span>
              <span>
                {session.participants.length}{" "}
                {placesWord(session.participants.length)}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <nav
      className={styles.side}
      aria-label="Занятия"
      data-help="teacher-sessions"
    >
      <h2 className={styles.sideTitle}>Занятия</h2>
      <button
        type="button"
        className={styles.primary}
        aria-pressed={view.kind === "new"}
        onClick={() => onSelect({ kind: "new" })}
      >
        + Новое занятие
      </button>

      {sessions.isPending && <p className={styles.sideNote}>Загружаем…</p>}
      {sessions.isError && (
        <p role="alert" className={styles.sideNote}>
          Занятия не загрузились.{" "}
          <button
            type="button"
            className={styles.link}
            onClick={() => void sessions.refetch()}
          >
            Повторить
          </button>
        </p>
      )}
      {sessions.data?.length === 0 && (
        <p className={styles.sideNote}>
          Занятий пока нет. Нажмите «+ Новое занятие»: добавьте рабочие места и
          обучаемых, затем запустите — здесь появится ход работы.
        </p>
      )}

      <div className={styles.sessionGroups}>
        {running.length > 0 && sessionRows(running)}
        {drafts.length > 0 && (
          <section>
            <button
              type="button"
              className={styles.sessionGroupToggle}
              aria-expanded={showDrafts}
              aria-controls="draft-sessions"
              onClick={() => setShowDrafts(!showDrafts)}
            >
              <span>Черновики · {drafts.length}</span>
              <span aria-hidden="true">{showDrafts ? "▾" : "▸"}</span>
            </button>
            {showDrafts && <div id="draft-sessions">{sessionRows(drafts)}</div>}
          </section>
        )}
        {finished.length > 0 && (
          <section>
            <button
              type="button"
              className={styles.sessionGroupToggle}
              aria-expanded={showFinished}
              aria-controls="finished-sessions"
              onClick={() => setShowFinished(!showFinished)}
            >
              <span>Завершённые · {finished.length}</span>
              <span aria-hidden="true">{showFinished ? "▾" : "▸"}</span>
            </button>
            {showFinished && (
              <div id="finished-sessions">
                {showFinished && finished.length > 0 && (
                  <div className={styles.sessionSearch}>
                    <label htmlFor="finished-session-search">
                      Поиск завершённых занятий
                    </label>
                    <input
                      id="finished-session-search"
                      type="search"
                      placeholder="Название занятия"
                      value={finishedSearch}
                      onChange={(event) =>
                        setFinishedSearch(event.target.value)
                      }
                    />
                    {finishedSearch && (
                      <button
                        type="button"
                        className={styles.plain}
                        onClick={() => setFinishedSearch("")}
                      >
                        Сбросить поиск
                      </button>
                    )}
                    {matchingFinished.length === 0 && (
                      <p role="status" className={styles.sideNote}>
                        Завершённые занятия не найдены. Измените название или
                        сбросьте поиск.
                      </p>
                    )}
                  </div>
                )}

                {sessionRows(matchingFinished)}
              </div>
            )}
          </section>
        )}
      </div>

      <div className={styles.sideFoot}>
        <div className={styles.studioHeading}>
          <button
            type="button"
            className={styles.sideLink}
            aria-pressed={view.kind === "catalog"}
            aria-expanded={studioExpanded}
            aria-controls="studio-sections"
            onClick={() => {
              setStudioExpanded(!studioExpanded);
              if (!studioExpanded) onSelect({ kind: "catalog" });
            }}
          >
            Студия сценариев
            {scenarios.data && <span> · {scenarios.data.length}</span>}
          </button>
          <button
            type="button"
            className={styles.sideLink}
            aria-label={
              studioExpanded
                ? "Свернуть разделы студии"
                : "Раскрыть разделы студии"
            }
            aria-expanded={studioExpanded}
            aria-controls="studio-sections"
            onClick={() => setStudioExpanded(!studioExpanded)}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M2 1 8 5 2 9Z" fill="currentColor" />
            </svg>
          </button>
        </div>
        {studioExpanded && (
          <ul id="studio-sections" className={styles.studioSections}>
            {STUDIO_SECTIONS.map(([section, label]) => (
              <li key={section}>
                <button
                  type="button"
                  className={styles.sideLink}
                  aria-current={
                    view.kind === "catalog" &&
                    (view.section ?? "active") === section
                      ? "page"
                      : undefined
                  }
                  onClick={() => onSelect({ kind: "catalog", section })}
                >
                  {label}
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className={styles.sideLink}
          aria-pressed={view.kind === "materials"}
          onClick={() => onSelect({ kind: "materials" })}
        >
          Материалы
        </button>
      </div>
    </nav>
  );
}

function placesWord(count: number): string {
  const tail = count % 100;
  if (tail >= 11 && tail <= 14) return "мест";
  if (count % 10 === 1) return "место";
  if ([2, 3, 4].includes(count % 10)) return "места";
  return "мест";
}
