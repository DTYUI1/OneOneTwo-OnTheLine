import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Card } from "../shared/api";
import { ArmIcon } from "./ArmIcon";
import { fullDateTime } from "./cardModel";
import { buildHistory, type HistoryEntry, type HistoryEvent } from "./historyModel";
import styles from "./CardHistory.module.css";

const EMPTY_EVENTS: readonly HistoryEvent[] = [];

function matches(entry: HistoryEntry, query: string): boolean {
  return [entry.label, entry.comment, entry.operator, entry.operatorTitle, fullDateTime(new Date(entry.at))]
    .join(" ")
    .toLocaleLowerCase("ru-RU")
    .includes(query.trim().toLocaleLowerCase("ru-RU"));
}

/** Журнал в нижней части АРМ: шапка неподвижна, прокручиваются только записи. */
export function CardHistory({
  card,
  events = EMPTY_EVENTS,
  workstation,
  traineeName,
  services,
  serviceName,
  lateId,
  open,
  loading,
  error,
  onRetry,
  onClose,
}: {
  card: Card;
  events?: readonly HistoryEvent[];
  workstation: string | number;
  traineeName?: string;
  services: readonly { id: string; name: string }[];
  serviceName: string;
  lateId: string | null;
  open: boolean;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onClose: () => void;
}) {
  const [all, setAll] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [unseen, setUnseen] = useState(0);
  const panel = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const wasOpen = useRef(false);
  const previousIds = useRef(new Set<string>());
  const entries = useMemo(
    () => buildHistory({ card, events, workstation, traineeName, services, lateId }),
    [card, events, workstation, traineeName, services, lateId],
  );
  const visible = useMemo(
    () => entries.filter((entry) => (all || entry.primary) && matches(entry, query)),
    [entries, all, query],
  );
  const visibleIds = new Set(visible.map((entry) => entry.id));

  const latest = useCallback(() => {
    follow.current = true;
    const element = body.current;
    if (element) element.scrollTop = element.scrollHeight;
    setUnseen(0);
  }, []);

  useLayoutEffect(() => {
    if (open) panel.current?.focus({ preventScroll: true });
  }, [open, card.id]);

  useLayoutEffect(() => {
    if (open) {
      const newlyOpened = !wasOpen.current;
      if (newlyOpened || follow.current) latest();
      else {
        const fresh = visible.filter((entry) => !previousIds.current.has(entry.id)).length;
        if (fresh) setUnseen((count) => count + fresh);
      }
    }
    previousIds.current = new Set(entries.map((entry) => entry.id));
    wasOpen.current = open;
  }, [entries, open, visible, latest]);

  return (
    <section
      ref={panel}
      id={`card-history-${card.id}`}
      className={styles.history}
      data-help="card-history"
      role="region"
      aria-label="История карточки"
      tabIndex={-1}
      hidden={!open}
    >
      <header className={styles.head}>
        <div className={styles.title}>
          <strong>История карточки</strong>
          <span title={serviceName}>{serviceName || "Журнал действий"}</span>
        </div>
        <button
          type="button"
          className={styles.close}
          onClick={onClose}
          aria-label="Закрыть историю статусов"
          title="Закрыть историю (Esc)"
        >
          <ArmIcon name="close" size="tiny" />
        </button>
      </header>
      <div className={styles.toolbar}>
        <div className={styles.filters} role="group" aria-label="Записи истории">
          <button
            type="button"
            aria-pressed={!all}
            onClick={() => { setAll(false); setExpanded(null); follow.current = true; }}
          >
            Статусы и комментарии
          </button>
          <button
            type="button"
            aria-pressed={all}
            onClick={() => { setAll(true); setExpanded(null); follow.current = true; }}
          >
            Все действия
          </button>
        </div>
        <input
          type="search"
          aria-label="Поиск по истории"
          placeholder="Найти в истории"
          value={query}
          onChange={(event) => { setQuery(event.target.value); setExpanded(null); follow.current = true; }}
        />
        <span className={styles.count} aria-live="polite">
          Записей: {visible.length}{loading ? " · обновление…" : ""}
        </span>
        <button type="button" className={styles.latest} onClick={latest}>
          {unseen ? `Новых записей: ${unseen}` : "К последней записи"}
        </button>
      </div>
      {error && (
        <div className={styles.error} role="alert">
          Не удалось обновить историю. Уже загруженные записи сохранены.
          <button type="button" onClick={onRetry}>Повторить</button>
        </div>
      )}
      <div
        ref={body}
        className={styles.body}
        onScroll={(event) => {
          const element = event.currentTarget;
          follow.current = element.scrollHeight - element.clientHeight - element.scrollTop < 20;
          if (follow.current) setUnseen(0);
        }}
      >
        <table className={styles.table} aria-label="Записи истории карточки">
          <colgroup>
            <col className={styles.timeColumn} />
            <col className={styles.actionColumn} />
            <col className={styles.actorColumn} />
            <col />
          </colgroup>
          <thead>
            <tr><th scope="col">Дата и время</th><th scope="col">Действие</th><th scope="col">Кто</th><th scope="col">Комментарий</th></tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const shown = visibleIds.has(entry.id);
              const detailed = expanded === entry.id;
              return (
                <Fragment key={entry.id}>
                  <tr
                    hidden={!shown}
                    className={detailed ? styles.selected : undefined}
                    data-history-id={entry.id}
                  >
                    <td className={styles.time}>
                      <time dateTime={entry.at} className={entry.late ? styles.late : undefined} title={entry.late ? "Первичное решение позже 30 секунд" : undefined}>
                        {fullDateTime(new Date(entry.at))}
                      </time>
                    </td>
                    <td>{entry.label}</td>
                    <td className={styles.operator} title={entry.operatorTitle}>{entry.operator}</td>
                    <td className={styles.comment}>
                      {entry.comment ? (
                        <button
                          type="button"
                          className={styles.commentButton}
                          aria-expanded={detailed}
                          aria-controls={`history-detail-${entry.id}`}
                          aria-label={`Комментарий: ${entry.label}, ${fullDateTime(new Date(entry.at))}`}
                          onClick={() => { follow.current = false; setExpanded(detailed ? null : entry.id); }}
                        >
                          <span className={styles.preview}>{entry.comment}</span>
                          <ArmIcon name={detailed ? "up" : "down"} size="tiny" />
                        </button>
                      ) : <span className={styles.emptyComment}>—</span>}
                    </td>
                  </tr>
                  {detailed && shown && (
                    <tr className={styles.details}>
                      <td colSpan={4}>
                        <div id={`history-detail-${entry.id}`} className={styles.fullComment} role="region" tabIndex={0} aria-label={`Полный комментарий: ${entry.label}`}>
                          {entry.comment}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {visible.length === 0 && (
          <p className={styles.empty}>{loading ? "Загрузка истории…" : query.trim() ? "По вашему запросу записей нет." : "Записей пока нет."}</p>
        )}
      </div>
    </section>
  );
}
