// Копии и корзина (C-07). Кнопка не выполняет команд на сервере: она записывает запрос,
// контейнер backup забирает его в течение минуты. Корзина показывает удалённые учётки:
// их ФИО и логин сотрутся только после успешной копии, начатой позже удаления.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, csrfToken } from "../shared/api";
import {
  BACKUP_STATUSES,
  ROLE_LABELS,
  TRASH_STATES,
  backupBusy,
  backupSource,
  backupTime,
  moment,
  type BackupRun,
  type TrashItem,
} from "./adminModel";
import kit from "../teacher/console/Console.module.css";
import styles from "./Admin.module.css";

export function BackupsPanel() {
  const queries = useQueryClient();
  const [notice, setNotice] = useState("");
  const users = useQuery({
    queryKey: ["users"],
    queryFn: async () => (await api.GET("/users")).data ?? [],
  });
  const backups = useQuery({
    queryKey: ["admin-backups"],
    queryFn: async () => {
      const { data, error } = await api.GET("/admin/backups");
      if (!data) throw new Error(error?.message ?? "Список копий недоступен.");
      return data;
    },
    // Пока копия запрошена или идёт — чаще, чтобы увидеть результат без обновления страницы.
    refetchInterval: (query) =>
      backupBusy(query.state.data ?? [], Date.now()) ? 5_000 : 30_000,
  });
  const trash = useQuery({
    queryKey: ["admin-trash"],
    queryFn: async () => {
      const { data, error } = await api.GET("/admin/trash");
      if (!data) throw new Error(error?.message ?? "Корзина недоступна.");
      return data;
    },
    refetchInterval: 15_000,
  });
  const request = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST("/admin/backups", {
        params: { header: { "X-CSRF-Token": csrfToken() } },
      });
      if (!data) throw new Error(error?.message ?? "Копия не запрошена.");
      return data;
    },
    onSuccess: async () => {
      setNotice(
        "Копия запрошена: начнётся в течение минуты. Состояние обновится здесь само.",
      );
      await queries.invalidateQueries({ queryKey: ["admin-backups"] });
      await queries.invalidateQueries({ queryKey: ["admin-status"] });
    },
  });
  const restore = useMutation({
    mutationFn: async (item: TrashItem) => {
      const { data, error } = await api.POST("/users/{id}/restore", {
        params: {
          header: { "X-CSRF-Token": csrfToken() },
          path: { id: item.id },
        },
      });
      if (!data) throw new Error(error?.message ?? "Не восстановлено.");
      return data;
    },
    onSuccess: async (user) => {
      setNotice(
        `${user.login} возвращён из корзины заблокированным — откройте доступ в разделе «Пользователи».`,
      );
      await queries.invalidateQueries({ queryKey: ["admin-trash"] });
      await queries.invalidateQueries({ queryKey: ["users"] });
    },
  });

  const userName = (id: string) =>
    (users.data ?? []).find((user) => user.id === id)?.full_name ?? null;
  const busy = backupBusy(backups.data ?? [], Date.now());

  return (
    <div className={kit.tabBody}>
      {notice && (
        <p role="status" className={kit.message}>
          {notice}
        </p>
      )}

      <div className={kit.panel}>
        <div className={kit.actions}>
          <h3 className={kit.panelTitle}>Резервные копии</h3>
          <button
            type="button"
            className={kit.primary}
            disabled={busy || request.isPending}
            title={busy ? "Копия уже запрошена или идёт." : undefined}
            onClick={() => {
              setNotice("");
              request.mutate();
            }}
          >
            Сделать копию сейчас
          </button>
        </div>
        <p className={kit.hint}>
          Копия базы данных, записей докладов и учебных материалов делается
          каждый день в {backupTime()}, а по кнопке — в течение минуты. Копии
          лежат на сервере в папке резервных копий, на компьютер администратора
          ничего не скачивается. Храните эту папку на отдельном диске.
        </p>
        {request.isError && <p role="alert">{request.error.message}</p>}
        {backups.isPending && (
          <p className={kit.placeholder}>Загружаем список копий…</p>
        )}
        {backups.isError && (
          <p role="alert" className={kit.placeholder}>
            {backups.error.message}
          </p>
        )}
        {backups.data && backups.data.length === 0 && (
          <p className={kit.placeholder}>
            Копий ещё не было. Сделайте первую перед занятием.
          </p>
        )}
        {backups.data && backups.data.length > 0 && (
          <div className={styles.wide}>
            <table className={kit.table}>
              <thead>
                <tr>
                  <th>Запрошена</th>
                  <th>Кто</th>
                  <th>Состояние</th>
                  <th>Завершена</th>
                  <th>Копия</th>
                </tr>
              </thead>
              <tbody>
                {backups.data.map((run) => (
                  <BackupRow key={run.id} run={run} userName={userName} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className={kit.panel}>
        <h3 className={kit.panelTitle}>Корзина</h3>
        <p className={kit.hint}>
          Удалённая учётная запись сразу закрыта для входа. После ближайшей
          успешной копии её ФИО, логин и пароль сотрутся, в отчётах и журнале
          останется «Удалённый пользователь». До этого её можно вернуть.
          {trash.data &&
            ` Последняя успешная копия: ${moment(trash.data.last_backup_at)}.`}
        </p>
        {restore.isError && <p role="alert">{restore.error.message}</p>}
        {trash.isPending && (
          <p className={kit.placeholder}>Загружаем корзину…</p>
        )}
        {trash.isError && (
          <p role="alert" className={kit.placeholder}>
            {trash.error.message}
          </p>
        )}
        {trash.data && trash.data.items.length === 0 && (
          <p className={kit.placeholder}>Корзина пуста.</p>
        )}
        {trash.data && trash.data.items.length > 0 && (
          <div className={styles.wide}>
            <table className={kit.table}>
              <thead>
                <tr>
                  <th>ФИО</th>
                  <th>Логин</th>
                  <th>Роль</th>
                  <th>Удалена</th>
                  <th>Причина</th>
                  <th>Состояние</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                {trash.data.items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.title}</td>
                    <td>
                      <code>{item.login}</code>
                    </td>
                    <td>{ROLE_LABELS[item.role]}</td>
                    <td>
                      {moment(item.deleted_at)}
                      {item.deleted_by && userName(item.deleted_by) && (
                        <span className={kit.muted}>
                          {" "}
                          · {userName(item.deleted_by)}
                        </span>
                      )}
                    </td>
                    <td>{item.reason ?? "—"}</td>
                    <td>
                      <span
                        className={
                          item.state === "purged" ? styles.on : styles.off
                        }
                      >
                        {TRASH_STATES[item.state]}
                      </span>
                      {item.purged_at && (
                        <span className={kit.muted}>
                          {" "}
                          {moment(item.purged_at)}
                        </span>
                      )}
                    </td>
                    <td className={kit.rowActions}>
                      {item.state === "purged" ? (
                        "—"
                      ) : (
                        <button
                          type="button"
                          className={kit.plain}
                          aria-label={`Восстановить: ${item.login}`}
                          disabled={restore.isPending}
                          onClick={() => {
                            setNotice("");
                            restore.mutate(item);
                          }}
                        >
                          Восстановить
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function BackupRow({
  run,
  userName,
}: {
  run: BackupRun;
  userName: (id: string) => string | null;
}) {
  return (
    <tr>
      <td>{moment(run.requested_at)}</td>
      <td>{backupSource(run, userName)}</td>
      <td>
        <span
          className={
            run.status === "failed"
              ? styles.fail
              : run.status === "done"
                ? styles.on
                : styles.off
          }
        >
          {BACKUP_STATUSES[run.status]}
        </span>
      </td>
      <td>{moment(run.finished_at)}</td>
      <td>
        {run.status === "failed" ? (run.error ?? "—") : (run.name ?? "—")}
      </td>
    </tr>
  );
}
