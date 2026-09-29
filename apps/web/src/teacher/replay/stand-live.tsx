// Живой стенд реплея: настоящий вход преподавателем, настоящие журнал и
// вердикт. Нужен, пока реплей никуда не смонтирован.
//
// Запуск — профиль dev, чтобы Vite ходил в api внутри сети compose:
//   docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.dev.yml \
//     --profile dev up -d --wait
//   http://127.0.0.1:5173/app/src/teacher/replay/stand-live.html
//
// В сборку страница не попадает: точка входа одна — index.html.

import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api, type Card, type User } from "../../shared/api";
import { SessionContext } from "../../shared/session";
import { RealtimeClient } from "../../shared/ws/client";
import { Replay } from "./Replay";
import "../../shared/tokens.css";

const client = new QueryClient();
const LOGIN = "teacher";

function Live() {
  const [user, setUser] = useState<User | null>(null);
  const [realtime, setRealtime] = useState<RealtimeClient | null>(null);
  const [cards, setCards] = useState<readonly Card[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
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
      const list = await api.GET("/cards");
      setUser(login.data);
      setRealtime(socket);
      setCards(list.data ?? []);
      // Разбирают обычно закрытую карточку, с неё и начинаем.
      const closed = (list.data ?? []).find((card) => card.closed_at !== null);
      setChosen((closed ?? list.data?.[0])?.id ?? null);
    })();
    return () => socket?.stop();
  }, []);

  if (error) return <p role="alert">{error}</p>;
  if (!user || !realtime) return <p>Вход под {LOGIN}…</p>;
  if (!chosen) return <p>Карточек ещё нет — проведите занятие.</p>;

  return (
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={{ user, realtime }}>
        <div style={{ padding: "16px 16px 0" }}>
          <label>
            Карточка{" "}
            <select
              value={chosen}
              onChange={(event) => setChosen(event.target.value)}
            >
              {cards.map((card) => (
                <option key={card.id} value={card.id}>
                  {card.source.number} · {card.source.incident_class} ·{" "}
                  {card.state}
                </option>
              ))}
            </select>
          </label>
        </div>
        <Replay cardId={chosen} />
        <p style={{ padding: "0 16px 16px", maxWidth: "640px", opacity: 0.8 }}>
          Журнал, службы, нормативы и вердикт поступают с сервера. Содержание
          разбора зависит от данных выбранной попытки.
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
