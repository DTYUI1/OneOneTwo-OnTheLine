// Живой стенд софтфона: настоящий вход, настоящий api, настоящий WebSocket.
// Берёт активную карточку обучаемого и показывает на ней ту же панель, что
// встанет в шапку карточки. Нужен, пока софтфон никуда не смонтирован.
//
// Запуск — профиль dev, чтобы Vite ходил в api внутри сети compose:
//   docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.dev.yml \
//     --profile dev up -d --wait
//   http://127.0.0.1:5173/app/src/arm/softphone/stand-live.html
//
// В сборку страница не попадает: точка входа одна — index.html.

import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api, type Card, type User } from "../../shared/api";
import { SessionContext } from "../../shared/session";
import { RealtimeClient } from "../../shared/ws/client";
import { Softphone } from "./Softphone";
import "../../shared/tokens.css";

const client = new QueryClient();
const LOGIN = "trainee01";

async function signIn(): Promise<User> {
  const login = await api.POST("/auth/login", {
    body: { login: LOGIN, password: "demo-local" },
  });
  if (!login.data) throw new Error("Вход не прошёл. Поднят ли стенд?");
  return login.data;
}

function Live() {
  const [user, setUser] = useState<User | null>(null);
  const [realtime, setRealtime] = useState<RealtimeClient | null>(null);
  const [card, setCard] = useState<Card | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let socket: RealtimeClient | null = null;
    void (async () => {
      try {
        const me = await signIn();
        socket = new RealtimeClient(me.id, () => {});
        socket.start();
        const cards = await api.GET("/cards");
        const mine = (cards.data ?? []).find((item) => item.closed_at === null);
        setUser(me);
        setRealtime(socket);
        setCard(mine ?? cards.data?.[0] ?? null);
      } catch (reason) {
        setError(
          reason instanceof Error ? reason.message : "Стенд недоступен.",
        );
      }
    })();
    return () => socket?.stop();
  }, []);

  if (error) return <p role="alert">{error}</p>;
  if (!user || !realtime) return <p>Вход под {LOGIN}…</p>;
  if (!card)
    return (
      <p>
        У {LOGIN} нет карточек. Создайте занятие преподавателем и дождитесь
        выдачи — планировщик отдаёт карточку по расписанию назначения.
      </p>
    );

  return (
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={{ user, realtime }}>
        <div style={{ background: "#849097", minHeight: "100vh" }}>
          <Softphone
            cardId={card.id}
            serviceIds={card.source.service_ids}
            cardState={card.state}
          />
          <div style={{ color: "#fff", padding: "16px", maxWidth: "640px" }}>
            <p>
              Карточка {card.source.number} · {card.source.incident_class} ·
              состояние {card.state}. Службы карточки:{" "}
              {card.source.service_ids.join(", ")}.
            </p>
            <p>
              Это настоящий api: набор уходит событием `call_dial`, ответ службы
              — `call_answer`, отбой — `call_hangup`, запись ложится файлом.
              Сервер принимает запись только после отбоя, поэтому загрузка ждёт
              его; если сеть моргнёт, запись придержится и кнопка повтора
              отправит её снова.
            </p>
          </div>
        </div>
      </SessionContext.Provider>
    </QueryClientProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Live />
  </StrictMode>,
);
