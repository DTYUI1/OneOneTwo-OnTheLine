// Живой стенд доски: настоящий вход преподавателем, настоящие занятие,
// карточки и WebSocket. Нужен, пока доска никуда не смонтирована.
//
// Запуск — профиль dev, чтобы Vite ходил в api внутри сети compose:
//   docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.dev.yml \
//     --profile dev up -d --wait
//   http://127.0.0.1:5173/app/src/teacher/live/stand-live.html
//
// В сборку страница не попадает: точка входа одна — index.html.

import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api, type User } from "../../shared/api";
import { SessionContext } from "../../shared/session";
import { RealtimeClient } from "../../shared/ws/client";
import { LiveBoard } from "./LiveBoard";
import "../../shared/tokens.css";

const client = new QueryClient();
const LOGIN = "teacher";

function Live() {
  const [user, setUser] = useState<User | null>(null);
  const [realtime, setRealtime] = useState<RealtimeClient | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let socket: RealtimeClient | null = null;
    void (async () => {
      const login = await api.POST("/auth/login", {
        body: { login: LOGIN, password: "demo-local" },
      });
      if (!login.data) {
        setError("Вход не прошёл. Поднят ли стенд?");
        return;
      }
      socket = new RealtimeClient(login.data.id, () => {});
      socket.start();
      setUser(login.data);
      setRealtime(socket);
    })();
    return () => socket?.stop();
  }, []);

  if (error) return <p role="alert">{error}</p>;
  if (!user || !realtime) return <p>Вход под {LOGIN}…</p>;

  return (
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={{ user, realtime }}>
        <LiveBoard />
        <p style={{ padding: "0 16px 16px", maxWidth: "640px", opacity: 0.8 }}>
          Здесь показаны данные сервера. Изменения появляются автоматически.
          Карточки появятся после начала занятия и выдачи заданий обучаемым.
          Состояние рабочего места показывает, подключён ли обучаемый.
        </p>
      </SessionContext.Provider>
    </QueryClientProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Live />
  </StrictMode>,
);
