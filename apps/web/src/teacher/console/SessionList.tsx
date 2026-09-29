// Левая колонка пульта: занятия по группам и переходы к созданию и каталогу.
// Раскладка повторяет «Список происшествий» АРМ — стальное поле, белый заголовок.
import { useState } from "react";
import { SESSION_STATUS_LABELS, sortSessions, type SessionTab } from "./model";
import { useScenarios, useSessions } from "./useConsoleData";
import styles from "./Console.module.css";

export type ConsoleView =
  | { kind: "empty" }
  | { kind: "new" }
  | { kind: "catalog" }
  | { kind: "materials" }
  | { kind: "session"; id: string; tab?: SessionTab };

export function SessionList({
  view,
  onSelect,
}: {
  view: ConsoleView;
  onSelect: (view: ConsoleView) => void;
}) {
  const sessions = useSessions();
  const scenarios = useScenarios();
  const [showFinished, setShowFinished] = useState(false);
  const [finishedSearch, setFinishedSearch] = useState("");

  const sorted = sortSessions(sessions.data ?? []);
  const finished = sorted.filter((session) => session.status === "finished");
  const search = finishedSearch.trim().toLocaleLowerCase("ru-RU");
  const matchingFinished = finished.filter((session) =>
    session.title.toLocaleLowerCase("ru-RU").includes(search),
  );
  const visible = [
    ...sorted.filter((session) => session.status !== "finished"),
    ...(showFinished ? matchingFinished : []),
  ];
  const selectedId = view.kind === "session" ? view.id : null;

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
        <p className={styles.sideNote}>Занятий пока нет.</p>
      )}

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
            onChange={(event) => setFinishedSearch(event.target.value)}
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
              Завершённые занятия не найдены. Измените название или сбросьте
              поиск.
            </p>
          )}
        </div>
      )}

      <ul className={styles.sessionList}>
        {visible.map((session) => (
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

      {finished.length > 0 && (
        <button
          type="button"
          className={styles.link}
          onClick={() => setShowFinished(!showFinished)}
        >
          {showFinished
            ? "Скрыть завершённые"
            : `Показать завершённые (${finished.length})`}
        </button>
      )}

      <div className={styles.sideFoot}>
        <button
          type="button"
          className={styles.sideLink}
          aria-pressed={view.kind === "catalog"}
          onClick={() => onSelect({ kind: "catalog" })}
        >
          Студия сценариев
          {scenarios.data && <span> · {scenarios.data.length}</span>}
        </button>
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
