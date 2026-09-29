// Учётные записи (C-07): создание, правка, пароль, блокировка — POST/PUT /users.
// Удаление — в корзину (POST /users/{id}/trash): вход закрывается сразу, ФИО и логин
// стираются только после резервной копии; до этого учётку можно вернуть из корзины.
// АРМ и служба здесь — значения профиля; на занятии преподаватель может назначить другие.
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, csrfToken } from "../shared/api";
import { useSession } from "../shared/session";
import {
  ROLE_LABELS,
  draftFromUser,
  emptyDraft,
  generatePassword,
  liveUsers,
  passwordProblem,
  toCreate,
  toUpdate,
  trashReasonProblem,
  userMatches,
  validateUserDraft,
  withRole,
  type RoleFilter,
  type StatusFilter,
  type User,
  type UserDraft,
} from "./adminModel";
import kit from "../teacher/console/Console.module.css";
import styles from "./Admin.module.css";

const ROLE_ORDER: Record<User["role"], number> = {
  admin: 0,
  teacher: 1,
  trainee: 2,
};
const WORKSTATIONS = Array.from({ length: 23 }, (_, index) => index + 1);

type Open =
  | { kind: "create" }
  | { kind: "edit" | "password" | "block" | "trash"; id: string }
  | null;

export function UsersPanel({ onTrash }: { onTrash?: () => void } = {}) {
  const { user: me } = useSession();
  const queries = useQueryClient();
  const users = useQuery({
    queryKey: ["users"],
    queryFn: async () => {
      const { data, error } = await api.GET("/users");
      if (!data) throw new Error(error?.message ?? "Пользователи недоступны.");
      return data;
    },
  });
  const services = useQuery({
    queryKey: ["services"],
    queryFn: async () => {
      const { data } = await api.GET("/services");
      return data ?? [];
    },
  });
  const [open, setOpen] = useState<Open>(null);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<RoleFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");

  const serviceName = (id: string | null) =>
    id
      ? ((services.data ?? []).find((service) => service.id === id)?.name ?? id)
      : "—";
  const done = async (message: string) => {
    setOpen(null);
    setNotice(message);
    await queries.invalidateQueries({ queryKey: ["users"] });
  };
  const start = (next: Open) => {
    setNotice("");
    setOpen(next);
  };

  if (users.isPending)
    return <p className={kit.placeholder}>Загружаем пользователей…</p>;
  if (!users.data)
    return (
      <p role="alert" className={kit.placeholder}>
        Пользователи недоступны.
      </p>
    );

  const live = liveUsers(users.data);
  const inTrash = users.data.length - live.length;
  const sorted = [...live].sort(
    (a, b) =>
      ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
      (a.workstation_number ?? 99) - (b.workstation_number ?? 99) ||
      a.login.localeCompare(b.login),
  );
  const shown = sorted.filter((user) => userMatches(user, query, role, status));
  const counts = live.reduce<Record<string, number>>(
    (acc, user) => ({ ...acc, [user.role]: (acc[user.role] ?? 0) + 1 }),
    {},
  );
  const blocked = live.filter((user) => !user.is_active).length;
  const target =
    open && open.kind !== "create"
      ? (live.find((user) => user.id === open.id) ?? null)
      : null;

  return (
    <div className={kit.tabBody}>
      {notice && (
        <p role="status" className={kit.message}>
          {notice}
        </p>
      )}

      {open?.kind === "create" && (
        <UserForm
          mode="create"
          initial={emptyDraft()}
          services={services.data ?? []}
          self={false}
          onCancel={() => setOpen(null)}
          onDone={(user, password) =>
            void done(
              `Создана учётная запись ${user.login}. Пароль: ${password} — передайте его пользователю, повторно он не показывается.`,
            )
          }
        />
      )}
      {open?.kind === "edit" && target && (
        <UserForm
          mode="edit"
          initial={draftFromUser(target)}
          userId={target.id}
          services={services.data ?? []}
          self={target.id === me.id}
          onCancel={() => setOpen(null)}
          onDone={(user) => void done(`Сохранено: ${user.full_name}.`)}
        />
      )}
      {open?.kind === "password" && target && (
        <PasswordForm
          user={target}
          self={target.id === me.id}
          onCancel={() => setOpen(null)}
          onDone={(password) =>
            void done(
              target.id === me.id
                ? `Ваш пароль изменён: ${password}. Другие ваши сеансы закрыты.`
                : `Новый пароль для ${target.login}: ${password}. Все сеансы пользователя закрыты — передайте пароль ему.`,
            )
          }
        />
      )}
      {open?.kind === "trash" && target && (
        <TrashConfirm
          user={target}
          onCancel={() => setOpen(null)}
          onDone={(user) =>
            void done(
              `${user.login} в корзине: вход закрыт. ФИО и логин сотрутся после ближайшей резервной копии, до этого учётную запись можно вернуть в разделе «Копии и корзина».`,
            )
          }
        />
      )}
      {open?.kind === "block" && target && (
        <BlockConfirm
          user={target}
          onCancel={() => setOpen(null)}
          onDone={(user) =>
            void done(
              user.is_active
                ? `${user.login} снова может входить в систему.`
                : `${user.login} заблокирован: вход закрыт, открытые вкладки завершены.`,
            )
          }
        />
      )}

      <div className={kit.panel}>
        <div className={kit.actions}>
          <h3 className={kit.panelTitle}>Учётные записи · {live.length}</h3>
          <button
            type="button"
            className={kit.primary}
            onClick={() => start({ kind: "create" })}
          >
            + Новый пользователь
          </button>
        </div>
        <p className={kit.hint}>
          {(Object.keys(ROLE_LABELS) as User["role"][])
            .filter((key) => counts[key])
            .map((key) => `${ROLE_LABELS[key]}: ${counts[key]}`)
            .join(" · ")}
          {blocked > 0 && ` · заблокировано: ${blocked}`}. АРМ и служба — из
          профиля; на занятии преподаватель может назначить другие.
          {inTrash > 0 && (
            <>
              {" "}
              Удалено: {inTrash}
              {onTrash && (
                <>
                  {" — "}
                  <button type="button" className={kit.plain} onClick={onTrash}>
                    открыть корзину
                  </button>
                </>
              )}
              .
            </>
          )}
        </p>
        <div className={kit.actions}>
          <label className={kit.field}>
            Поиск
            <input
              type="search"
              value={query}
              placeholder="ФИО или логин"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label className={kit.field}>
            Роль
            <select
              value={role}
              onChange={(event) => setRole(event.target.value as RoleFilter)}
            >
              <option value="all">все</option>
              <option value="trainee">обучаемые</option>
              <option value="teacher">преподаватели</option>
              <option value="admin">администраторы</option>
            </select>
          </label>
          <label className={kit.field}>
            Доступ
            <select
              value={status}
              onChange={(event) =>
                setStatus(event.target.value as StatusFilter)
              }
            >
              <option value="all">все</option>
              <option value="active">действует</option>
              <option value="blocked">заблокирован</option>
            </select>
          </label>
        </div>
        <div className={styles.wide}>
          <table className={kit.table}>
            <thead>
              <tr>
                <th>ФИО</th>
                <th>Логин</th>
                <th>Роль</th>
                <th>АРМ</th>
                <th>Служба</th>
                <th>Доступ</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((user) => (
                <tr key={user.id}>
                  <td>
                    {user.full_name}
                    {user.id === me.id && (
                      <span className={kit.muted}> · это вы</span>
                    )}
                  </td>
                  <td>
                    <code>{user.login}</code>
                  </td>
                  <td>{ROLE_LABELS[user.role]}</td>
                  <td className={kit.seat}>{user.workstation_number ?? "—"}</td>
                  <td>{serviceName(user.dds_service_id)}</td>
                  <td>
                    <span className={user.is_active ? styles.on : styles.off}>
                      {user.is_active ? "действует" : "заблокирован"}
                    </span>
                  </td>
                  <td className={kit.rowActions}>
                    <button
                      type="button"
                      className={kit.plain}
                      aria-label={`Изменить: ${user.login}`}
                      onClick={() => start({ kind: "edit", id: user.id })}
                    >
                      Изменить
                    </button>
                    <button
                      type="button"
                      className={kit.plain}
                      aria-label={`Пароль: ${user.login}`}
                      onClick={() => start({ kind: "password", id: user.id })}
                    >
                      Пароль
                    </button>
                    <button
                      type="button"
                      className={kit.plain}
                      aria-label={`${user.is_active ? "Заблокировать" : "Разблокировать"}: ${user.login}`}
                      disabled={user.id === me.id}
                      title={
                        user.id === me.id
                          ? "Свой доступ меняет другой администратор."
                          : undefined
                      }
                      onClick={() => start({ kind: "block", id: user.id })}
                    >
                      {user.is_active ? "Заблокировать" : "Разблокировать"}
                    </button>
                    <button
                      type="button"
                      className={kit.plain}
                      aria-label={`Удалить: ${user.login}`}
                      disabled={user.id === me.id}
                      title={
                        user.id === me.id
                          ? "Свою учётную запись удаляет другой администратор."
                          : undefined
                      }
                      onClick={() => start({ kind: "trash", id: user.id })}
                    >
                      Удалить
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length === 0 && (
            <p className={kit.placeholder}>Никого не нашли по этим условиям.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Панель действия над списком: получает фокус при открытии, Esc не нужен — есть «Отмена». */
function ActionPanel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest" });
    ref.current?.querySelector<HTMLElement>("input, select, button")?.focus();
  }, []);
  return (
    <div ref={ref} className={kit.panel} role="region" aria-label={title}>
      <h3 className={kit.panelTitle}>{title}</h3>
      {children}
    </div>
  );
}

function Problems({ list }: { list: string[] }) {
  if (list.length === 0) return null;
  return (
    <ul className={kit.problems} role="status">
      {list.map((problem) => (
        <li key={problem}>{problem}</li>
      ))}
    </ul>
  );
}

function PasswordField({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <div className={kit.actions}>
      <label className={kit.field}>
        {label}
        <input
          type="text"
          autoComplete="new-password"
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <button
        type="button"
        className={kit.plain}
        onClick={() => onChange(generatePassword())}
      >
        Придумать пароль
      </button>
    </div>
  );
}

function UserForm({
  mode,
  initial,
  userId,
  services,
  self,
  onCancel,
  onDone,
}: {
  mode: "create" | "edit";
  initial: UserDraft;
  userId?: string;
  services: { id: string; name: string; is_active: boolean }[];
  self: boolean;
  onCancel: () => void;
  onDone: (user: User, password: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [tried, setTried] = useState(false);
  const problems = validateUserDraft(draft, mode);
  const save = useMutation({
    mutationFn: async () => {
      const header = { "X-CSRF-Token": csrfToken() };
      const result =
        mode === "create"
          ? await api.POST("/users", {
              params: { header },
              body: toCreate(draft),
            })
          : await api.PUT("/users/{id}", {
              params: { header, path: { id: userId! } },
              body: toUpdate(draft),
            });
      if (!result.data)
        throw new Error(result.error?.message ?? "Не сохранено.");
      return result.data;
    },
    onSuccess: (user) => onDone(user, draft.password),
  });
  const set = (patch: Partial<UserDraft>) => setDraft({ ...draft, ...patch });
  const trainee = draft.role === "trainee";

  return (
    <ActionPanel
      title={
        mode === "create"
          ? "Новый пользователь"
          : `Изменить: ${initial.full_name}`
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          if (problems.length === 0) save.mutate();
        }}
      >
        <div className={kit.actions}>
          <label className={kit.field}>
            ФИО
            <input
              value={draft.full_name}
              maxLength={120}
              onChange={(event) => set({ full_name: event.target.value })}
            />
          </label>
          {mode === "create" ? (
            <label className={kit.field}>
              Логин
              <input
                value={draft.login}
                maxLength={32}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) =>
                  set({ login: event.target.value.trim().toLowerCase() })
                }
              />
            </label>
          ) : (
            <span className={kit.field}>
              Логин
              <code>{draft.login}</code>
            </span>
          )}
          <label className={kit.field}>
            Роль
            <select
              value={draft.role}
              disabled={self}
              onChange={(event) =>
                setDraft(withRole(draft, event.target.value as User["role"]))
              }
            >
              <option value="trainee">обучаемый</option>
              <option value="teacher">преподаватель</option>
              <option value="admin">администратор</option>
            </select>
          </label>
        </div>
        {trainee && (
          <div className={kit.actions}>
            <label className={kit.field}>
              АРМ по умолчанию
              <select
                value={draft.workstation_number ?? ""}
                onChange={(event) =>
                  set({
                    workstation_number: event.target.value
                      ? Number(event.target.value)
                      : null,
                  })
                }
              >
                <option value="">не задан</option>
                {WORKSTATIONS.map((number) => (
                  <option key={number} value={number}>
                    {number}
                  </option>
                ))}
              </select>
            </label>
            <label className={kit.field}>
              Служба по умолчанию
              <select
                value={draft.dds_service_id ?? ""}
                onChange={(event) =>
                  set({ dds_service_id: event.target.value || null })
                }
              >
                <option value="">не задана</option>
                {services
                  .filter(
                    (service) =>
                      service.is_active || service.id === draft.dds_service_id,
                  )
                  .map((service) => (
                    <option key={service.id} value={service.id}>
                      {service.name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
        )}
        {mode === "create" && (
          <PasswordField
            label="Пароль"
            value={draft.password}
            onChange={(password) => set({ password })}
          />
        )}
        <p className={kit.hint}>
          {mode === "create"
            ? "Логин потом не меняется. Пароль — не короче 8 символов; после создания он покажется один раз."
            : self
              ? "Свою роль и доступ меняет другой администратор."
              : "Смена роли закроет сеансы пользователя. Если у него уже есть занятия или материалы, роль не меняется — заведите новую учётную запись."}
        </p>
        {tried && <Problems list={problems} />}
        {save.isError && <p role="alert">{save.error.message}</p>}
        <div className={kit.actions}>
          <button
            type="submit"
            className={kit.primary}
            disabled={save.isPending}
          >
            {mode === "create" ? "Создать" : "Сохранить"}
          </button>
          <button type="button" className={kit.plain} onClick={onCancel}>
            Отмена
          </button>
        </div>
      </form>
    </ActionPanel>
  );
}

function PasswordForm({
  user,
  self,
  onCancel,
  onDone,
}: {
  user: User;
  self: boolean;
  onCancel: () => void;
  onDone: (password: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [tried, setTried] = useState(false);
  const problem = passwordProblem(password);
  const save = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST("/users/{id}/password", {
        params: {
          header: { "X-CSRF-Token": csrfToken() },
          path: { id: user.id },
        },
        body: { password },
      });
      if (!data) throw new Error(error?.message ?? "Пароль не изменён.");
      return data;
    },
    onSuccess: () => onDone(password),
  });
  return (
    <ActionPanel title={`Новый пароль: ${user.login}`}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          if (!problem) save.mutate();
        }}
      >
        <PasswordField
          label="Новый пароль"
          value={password}
          onChange={setPassword}
        />
        <p className={kit.hint}>
          {self
            ? "Эта вкладка останется открытой, другие ваши сеансы закроются."
            : "Все открытые сеансы пользователя закроются, войти он сможет только с новым паролем."}
        </p>
        {tried && problem && <Problems list={[problem]} />}
        {save.isError && <p role="alert">{save.error.message}</p>}
        <div className={kit.actions}>
          <button
            type="submit"
            className={kit.primary}
            disabled={save.isPending}
          >
            Сохранить пароль
          </button>
          <button type="button" className={kit.plain} onClick={onCancel}>
            Отмена
          </button>
        </div>
      </form>
    </ActionPanel>
  );
}

function BlockConfirm({
  user,
  onCancel,
  onDone,
}: {
  user: User;
  onCancel: () => void;
  onDone: (user: User) => void;
}) {
  const blocking = user.is_active;
  const save = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.PUT("/users/{id}", {
        params: {
          header: { "X-CSRF-Token": csrfToken() },
          path: { id: user.id },
        },
        body: toUpdate({ ...draftFromUser(user), is_active: !blocking }),
      });
      if (!data) throw new Error(error?.message ?? "Не сохранено.");
      return data;
    },
    onSuccess: onDone,
  });
  return (
    <ActionPanel
      title={`${blocking ? "Заблокировать" : "Разблокировать"}: ${user.login}`}
    >
      <p className={blocking ? kit.warning : kit.hint}>
        {blocking
          ? `${user.full_name} больше не сможет войти, открытые вкладки завершатся сразу. Если он сейчас на занятии, его карточки останутся без ответа. История занятий и оценок сохраняется.`
          : `${user.full_name} снова сможет входить со своим паролем.`}
      </p>
      {save.isError && <p role="alert">{save.error.message}</p>}
      <div className={kit.actions}>
        <button
          type="button"
          className={kit.primary}
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          {blocking ? "Да, заблокировать" : "Разблокировать"}
        </button>
        <button type="button" className={kit.plain} onClick={onCancel}>
          Отмена
        </button>
      </div>
    </ActionPanel>
  );
}

function TrashConfirm({
  user,
  onCancel,
  onDone,
}: {
  user: User;
  onCancel: () => void;
  onDone: (user: User) => void;
}) {
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const problem = trashReasonProblem(reason);
  const save = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST("/users/{id}/trash", {
        params: {
          header: { "X-CSRF-Token": csrfToken() },
          path: { id: user.id },
        },
        body: { reason: reason.trim() },
      });
      if (!data) throw new Error(error?.message ?? "Не удалено.");
      return data;
    },
    onSuccess: onDone,
  });
  return (
    <ActionPanel title={`Удалить: ${user.login}`}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          if (!problem) save.mutate();
        }}
      >
        <p className={kit.warning}>
          {user.full_name} сразу выйдет из системы и пропадёт из списков.
          Занятия, оценки и журнал аудита сохранятся. После ближайшей резервной
          копии ФИО, логин и пароль сотрутся — в отчётах останется «Удалённый
          пользователь». До копии учётную запись можно вернуть в разделе «Копии
          и корзина».
        </p>
        <label className={kit.field}>
          Причина удаления
          <input
            value={reason}
            maxLength={300}
            placeholder="Например: выбыл из учебной группы"
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        {tried && problem && <Problems list={[problem]} />}
        {save.isError && <p role="alert">{save.error.message}</p>}
        <div className={kit.actions}>
          <button
            type="submit"
            className={kit.primary}
            disabled={save.isPending}
          >
            Удалить в корзину
          </button>
          <button type="button" className={kit.plain} onClick={onCancel}>
            Отмена
          </button>
        </div>
      </form>
    </ActionPanel>
  );
}
