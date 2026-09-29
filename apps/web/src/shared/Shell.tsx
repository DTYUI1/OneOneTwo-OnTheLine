import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  Navigate,
  Outlet,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { api, csrfToken, type User } from "./api";
import { SessionContext } from "./session";
import { RealtimeClient } from "./ws/client";
import { CHOOSE_TRAINING, WelcomeGate } from "./WelcomeGate";
import { describeOutage } from "./systemAlert";
import { HelpButton, HelpProvider } from "./help/HelpProvider";
import { HelpTip } from "./help/HelpTip";
import { WorkflowButton } from "./WorkflowGuide";
import { ReportButton } from "./ReportButton";
import styles from "./Shell.module.css";

/** Сбой сервера виден преподавателю и администратору на любом экране (FR-7.4). */
function SystemAlert({ role }: { role: User["role"] }) {
  const health = useQuery({
    queryKey: ["health"],
    retry: false,
    refetchInterval: 15_000,
    queryFn: async () => {
      const { data } = await api.GET("/health");
      if (!data) throw new Error("Сервер не ответил.");
      return data;
    },
  });
  const problems = describeOutage(health.data ?? null, health.isError);
  if (problems.length === 0) return null;
  return (
    <div role="alert" className={styles.outage}>
      <strong>Сбой системы.</strong>
      {problems.map((problem) => (
        <span key={problem}>{problem}</span>
      ))}
      <span>
        {role === "admin"
          ? "Подробности — «Состояние системы» в администрировании."
          : "Сообщите администратору."}
      </span>
    </div>
  );
}

function AuthorizedShell({ user }: { user: User }) {
  const header = useRef<HTMLElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  // Карточка оператора 112 во весь экран, как в card_112: без шапки тренажёра.
  const bare = useLocation().pathname.startsWith("/operator");
  useLayoutEffect(() => {
    const update = () =>
      shell.current?.style.setProperty(
        "--shell-height",
        `${header.current?.getBoundingClientRect().height ?? (bare ? 0 : 68)}px`,
      );
    const observer = new ResizeObserver(update);
    if (header.current) observer.observe(header.current);
    update();
    return () => observer.disconnect();
  }, [bare]);
  const queries = useQueryClient();
  const navigate = useNavigate();
  const [clock, setClock] = useState(new Date());
  const [error, setError] = useState("");
  const realtime = useMemo(
    () =>
      new RealtimeClient(user.id, (event) => {
        if (
          event.type === "session.started" ||
          event.type === "session.finished"
        ) {
          const queryKey = ["session", event.payload.id];
          // Запоздалый HTTP-ответ не должен вернуть running после session.finished.
          void queries.cancelQueries({ queryKey, exact: true });
          queries.setQueryData(queryKey, event.payload);
        } else if (event.type === "snapshot") {
          void queries.invalidateQueries({ queryKey: ["session"] });
          void queries.invalidateQueries({ queryKey: ["card-events"] });
        }
        if (event.type === "card.updated") {
          // Историю обновляем после подтверждения сервера. Запись в очередь
          // ещё не означает, что событие уже доступно в истории карточки.
          void queries.invalidateQueries({
            queryKey: ["card-events", event.payload.id],
          });
        }
        if (event.type !== "clock.pong" && event.type !== "presence") {
          void queries.invalidateQueries({ queryKey: ["cards"] });
          void queries.invalidateQueries({ queryKey: ["sessions"] });
        }
      }),
    [user.id, queries],
  );
  useEffect(() => {
    realtime.start();
    return () => realtime.stop();
  }, [realtime]);
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  async function logout() {
    try {
      const { error } = await api.POST("/auth/logout", {
        params: { header: { "X-CSRF-Token": csrfToken() } },
      });
      if (error) {
        setError(error.message);
        return;
      }
      realtime.stop();
      queries.clear();
      navigate("/login", { replace: true });
    } catch {
      setError("Не удалось выйти: сервер недоступен.");
    }
  }
  return (
    <SessionContext.Provider value={{ user, realtime }}>
      <HelpProvider>
        <div ref={shell} className={styles.shell}>
          {!bare && (
            <header ref={header} className={styles.header}>
              <span>ГБУ Система 112 · Учебный симулятор</span>
              <span>
                {user.full_name}
                {user.workstation_number && ` · АРМ ${user.workstation_number}`}
              </span>
              <time>{clock.toLocaleTimeString("ru-RU")}</time>
              {user.role === "trainee" && (
                <Link to="/arm/results">Мои результаты</Link>
              )}
              {user.role === "trainee" && <WorkflowButton />}
              <ReportButton />
              {/* Обучаемый — к выбору обучения «112» / «Диспетчер служб» (просьба
                  капитана 29.09), у преподавателя выбора нет — сразу в модуль. */}
              {user.role === "trainee" && (
                <Link to="/arm" state={CHOOSE_TRAINING}>
                  Оператор 112
                </Link>
              )}
              {user.role === "teacher" && (
                <Link to="/operator">Оператор 112</Link>
              )}
              <button onClick={() => void logout()}>Выйти</button>
              {/* Место «?» занято и там, где у экрана нет объяснения: кнопки шапки
                  не уезжают влево, когда «?» появляется (список → карточка). */}
              <span className={styles.helpSlot}>
                <HelpButton />
              </span>
            </header>
          )}
          {!bare && <HelpTip userId={user.id} />}
          {error && <p role="alert">{error}</p>}
          {user.role !== "trainee" && <SystemAlert role={user.role} />}
          <Outlet />
        </div>
      </HelpProvider>
    </SessionContext.Provider>
  );
}

export function Shell({ roles }: { roles: User["role"][] }) {
  const location = useLocation();
  const me = useQuery({
    queryKey: ["me"],
    retry: false,
    queryFn: async () => {
      const { data, response } = await api.GET("/auth/me");
      if (response.status === 401) return null;
      if (!data) throw new Error("Сервер недоступен.");
      return data;
    },
  });
  if (me.isPending) return <p>Загрузка…</p>;
  if (me.isError)
    return (
      <p role="alert">
        Не удалось загрузить сессию.{" "}
        <button onClick={() => void me.refetch()}>Повторить</button>
      </p>
    );
  if (!me.data)
    return (
      <Navigate
        to="/login"
        replace
        state={{
          returnTo: location.pathname + location.search + location.hash,
        }}
      />
    );
  if (!roles.includes(me.data.role))
    return <p role="alert">Недостаточно прав для этого раздела.</p>;
  // Приветствие при первом знакомстве — у каждой роли своё (28.09).
  return (
    <WelcomeGate key={me.data.id} user={me.data}>
      <AuthorizedShell user={me.data} />
    </WelcomeGate>
  );
}
