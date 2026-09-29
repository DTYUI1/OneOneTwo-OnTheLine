// Журнал аудита (C-07) — GET /audit: кто, что, когда и с каким результатом.
// Журнал только дописывается; у учебных записей администратор видит лишь факт действия.
import { Fragment, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "../shared/api";
import {
  AUDIT_CATEGORIES,
  ROLE_LABELS,
  actionLabel,
  actorless,
  auditChanges,
  entityLabel,
  type AuditCategory,
  type AuditEntry,
} from "./adminModel";
import kit from "../teacher/console/Console.module.css";
import styles from "./Admin.module.css";

type Result = "all" | "ok" | "error";
const PAGE = 50;

/** Граница дня в местном времени — в ISO для сервера. */
function dayStart(value: string, shiftDays = 0): string | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00`);
  date.setDate(date.getDate() + shiftDays);
  return date.toISOString();
}

function when(ts: string): string {
  return new Date(ts).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function AuditPanel() {
  const [category, setCategory] = useState<AuditCategory>("admin");
  const [result, setResult] = useState<Result>("all");
  const [actor, setActor] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // Раскрытая запись помнится вместе с фильтрами: при других условиях она свёрнута.
  const [opened, setOpened] = useState<{ key: string; id: string } | null>(
    null,
  );

  const users = useQuery({
    queryKey: ["users"],
    queryFn: async () => (await api.GET("/users")).data ?? [],
  });
  const services = useQuery({
    queryKey: ["services"],
    queryFn: async () => (await api.GET("/services")).data ?? [],
  });
  const filters = { category, result, actor, from, to };
  const filtersKey = JSON.stringify(filters);
  const audit = useInfiniteQuery({
    queryKey: ["audit", filters],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const { data, error } = await api.GET("/audit", {
        params: {
          query: {
            limit: PAGE,
            category,
            result,
            ...(pageParam ? { cursor: pageParam } : {}),
            ...(actor ? { actor_id: actor } : {}),
            ...(from ? { since: dayStart(from) } : {}),
            // «По» включительно: до начала следующего дня.
            ...(to ? { until: dayStart(to, 1) } : {}),
          },
        },
      });
      if (!data) throw new Error(error?.message ?? "Журнал недоступен.");
      return data;
    },
    getNextPageParam: (last) => last.next_cursor,
  });

  const lookups = {
    userName: (id: string) => {
      const user = (users.data ?? []).find((item) => item.id === id);
      return user ? `${user.full_name} (${user.login})` : null;
    },
    serviceName: (id: string) =>
      (services.data ?? []).find((item) => item.id === id)?.name ?? null,
  };
  const pages = audit.data?.pages ?? [];
  const items: AuditEntry[] = pages.flatMap((page) => page.items);
  const first = pages[0];

  return (
    <div className={kit.tabBody}>
      <div className={kit.panel}>
        <div className={kit.actions}>
          <label className={kit.field}>
            Категория
            <select
              value={category}
              onChange={(event) =>
                setCategory(event.target.value as AuditCategory)
              }
            >
              {(Object.keys(AUDIT_CATEGORIES) as AuditCategory[]).map((key) => (
                <option key={key} value={key}>
                  {AUDIT_CATEGORIES[key]}
                </option>
              ))}
            </select>
          </label>
          <label className={kit.field}>
            Результат
            <select
              value={result}
              onChange={(event) => setResult(event.target.value as Result)}
            >
              <option value="all">любой</option>
              <option value="ok">выполнено</option>
              <option value="error">отказ</option>
            </select>
          </label>
          <label className={kit.field}>
            Кто
            <select
              value={actor}
              onChange={(event) => setActor(event.target.value)}
            >
              <option value="">все</option>
              {(users.data ?? []).map((user) => (
                <option key={user.id} value={user.id}>
                  {user.full_name} ({user.login})
                </option>
              ))}
            </select>
          </label>
          <label className={kit.field}>
            С
            <input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label className={kit.field}>
            По
            <input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
        </div>
        <p className={kit.hint}>
          {first ? `Записей по условиям: ${first.total}. ` : ""}
          Журнал только дописывается: изменить или удалить запись нельзя. Он
          хранится в базе бессрочно
          {first?.oldest_ts
            ? `, самая ранняя запись — ${new Date(first.oldest_ts).toLocaleDateString("ru-RU")}`
            : ""}
          . У учебных записей виден только факт действия — результаты обучаемых
          администратору не показываются.
        </p>
      </div>

      {audit.isPending && <p className={kit.placeholder}>Загружаем журнал…</p>}
      {audit.isError && (
        <p role="alert" className={kit.placeholder}>
          {audit.error.message}
        </p>
      )}
      {audit.data && (
        <div className={kit.panel}>
          <div className={styles.wide}>
            <table className={kit.table}>
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Кто</th>
                  <th>Действие</th>
                  <th>Над чем</th>
                  <th>Результат</th>
                  <th>IP-адрес</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((entry) => {
                  const changes = auditChanges(entry, lookups);
                  const expandable = changes.length > 0 || entry.details_hidden;
                  const open =
                    opened?.key === filtersKey && opened.id === entry.id;
                  return (
                    <Fragment key={entry.id}>
                      <tr>
                        <td className={kit.seat}>{when(entry.ts)}</td>
                        <td>
                          {entry.actor ? (
                            <>
                              {entry.actor.full_name}{" "}
                              <span className={kit.muted}>
                                · {ROLE_LABELS[entry.actor.role]}
                              </span>
                            </>
                          ) : (
                            <span className={kit.muted}>
                              {actorless(entry.action)}
                            </span>
                          )}
                        </td>
                        <td>{actionLabel(entry.action)}</td>
                        <td>{entityLabel(entry, lookups)}</td>
                        <td>
                          <span className={entry.ok ? styles.on : styles.off}>
                            {entry.ok
                              ? "выполнено"
                              : `отказ${entry.status_code ? ` · ${entry.status_code}` : ""}`}
                          </span>
                        </td>
                        <td className={kit.seat}>{entry.ip ?? "—"}</td>
                        <td className={kit.rowActions}>
                          {expandable && (
                            <button
                              type="button"
                              className={kit.plain}
                              aria-expanded={open}
                              onClick={() =>
                                setOpened(
                                  open
                                    ? null
                                    : { key: filtersKey, id: entry.id },
                                )
                              }
                            >
                              {open ? "Скрыть" : "Подробнее"}
                            </button>
                          )}
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={7}>
                            {changes.length > 0 ? (
                              <ul className={kit.criteriaList}>
                                {changes.map((change) => (
                                  <li key={change.label}>
                                    <strong>{change.label}:</strong>{" "}
                                    {change.before !== null &&
                                      `${change.before} → `}
                                    {change.after}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className={kit.muted}>
                                Содержимое учебной записи администратору не
                                показывается — только факт действия.
                              </p>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            {items.length === 0 && (
              <p className={kit.placeholder}>Записей по этим условиям нет.</p>
            )}
          </div>
          {audit.hasNextPage && (
            <div className={kit.actions}>
              <button
                type="button"
                className={kit.plain}
                disabled={audit.isFetchingNextPage}
                onClick={() => void audit.fetchNextPage()}
              >
                {audit.isFetchingNextPage ? "Загружаем…" : "Показать ещё"}
              </button>
              <span className={kit.hint}>
                Показано {items.length} из {first?.total ?? items.length}.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
