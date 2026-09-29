import { expect } from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { test } from "./fixtures";

type ServerEvent = components["schemas"]["WsServerEvent"];

test("HTTP и 10 WS-соединений: snapshot, часы, broadcast и повтор события", async ({
  page,
  databaseCard,
}) => {
  const login = await page.request.post("/api/auth/login", {
    data: {
      login: "trainee01",
      password: process.env.DEMO_PASSWORD ?? "demo-local",
    },
  });
  expect(login.ok()).toBeTruthy();
  if (databaseCard) {
    const csrf = (await page.context().cookies()).find(
      (cookie) => cookie.name === "csrf",
    )!.value;
    const delivered = await page.request.post(
      `/api/cards/${databaseCard.id}/events`,
      {
        headers: { "X-CSRF-Token": csrf },
        data: {
          client_event_id: crypto.randomUUID(),
          client_ts: new Date().toISOString(),
          type: "deliver",
          payload: {},
        },
      },
    );
    expect(delivered.status()).toBe(200);
  }
  // Статическая страница сохраняет same-origin, но не открывает WS React-приложения.
  await page.goto("/api/health");
  const result = await page.evaluate(async (ownCardId) => {
    const sockets: WebSocket[] = [];
    const received: ServerEvent[][] = [];
    const waiters: Array<() => void> = [];
    const url = new URL("/ws", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const waitFor = (condition: () => boolean): Promise<void> =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Не дождались WS-события")),
          10000,
        );
        const check = () => {
          if (condition()) {
            clearTimeout(timeout);
            resolve();
          }
        };
        waiters.push(check);
        check();
      });
    try {
      for (let index = 0; index < 10; index++) {
        const messages: ServerEvent[] = [];
        received.push(messages);
        const socket = new WebSocket(url);
        sockets.push(socket);
        socket.onopen = () =>
          socket.send(
            JSON.stringify({
              type: "clock.ping",
              client_ts: new Date().toISOString(),
            }),
          );
        socket.onmessage = (message) => {
          messages.push(JSON.parse(String(message.data)) as ServerEvent);
          waiters.forEach((check) => check());
        };
      }
      await waitFor(() =>
        received.every(
          (messages) =>
            messages.some((item) => item.type === "snapshot") &&
            messages.some((item) => item.type === "clock.pong"),
        ),
      );
      const snapshot = received[0].find((item) => item.type === "snapshot");
      if (!snapshot || snapshot.type !== "snapshot")
        throw new Error("Нет snapshot");
      const cardId = ownCardId ?? snapshot.payload.cards[0].id;
      if (!snapshot.payload.cards.some((card) => card.id === cardId))
        throw new Error("Собственная карточка отсутствует в snapshot");
      const csrf = document.cookie
        .split("; ")
        .find((item) => item.startsWith("csrf="))
        ?.slice(5);
      if (!csrf) throw new Error("Нет CSRF cookie");
      const body = {
        client_event_id: crypto.randomUUID(),
        client_ts: new Date().toISOString(),
        type: "open",
        payload: {},
      };
      const send = () =>
        fetch(`/api/cards/${cardId}/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
          body: JSON.stringify(body),
        });
      const first = await send();
      const firstAck = await first.json();
      await waitFor(() =>
        received.every((messages) =>
          messages.some(
            (item) =>
              item.type === "card.updated" && item.payload.id === cardId,
          ),
        ),
      );
      const duplicate = await send();
      const duplicateAck = await duplicate.json();
      // Новый snapshot после переподключения должен содержать подтверждённое изменение.
      const reconnected = new WebSocket(url);
      sockets.push(reconnected);
      const restored = await new Promise<ServerEvent>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Нет snapshot после reconnect")),
          10000,
        );
        reconnected.onmessage = (message) => {
          const event = JSON.parse(String(message.data)) as ServerEvent;
          if (event.type === "snapshot") {
            clearTimeout(timeout);
            resolve(event);
          }
        };
      });
      return {
        firstStatus: first.status,
        duplicateStatus: duplicate.status,
        firstAck,
        duplicateAck,
        restored,
        cardId,
        connections: received.filter((messages) =>
          messages.some((item) => item.type === "card.updated"),
        ).length,
      };
    } finally {
      sockets.forEach((socket) => socket.close());
    }
  }, databaseCard?.id);
  expect(result.connections).toBe(10);
  expect(result.firstStatus).toBe(200);
  expect(result.duplicateStatus).toBe(200);
  expect(result.firstAck.duplicate).toBe(false);
  expect(result.duplicateAck.duplicate).toBe(true);
  expect(result.duplicateAck.server_ts).toBe(result.firstAck.server_ts);
  expect(result.restored.type).toBe("snapshot");
  if (result.restored.type === "snapshot") {
    expect(
      result.restored.payload.cards.find((card) => card.id === result.cardId)
        ?.opened_at,
    ).toBeTruthy();
  }
});

for (const [entry, target] of [
  ["/teacher", "/app/teacher"],
  ["/admin", "/app/admin"],
]) {
  test(`Прямой вход ${entry} сохраняет маршрут`, async ({ request }) => {
    const response = await request.get(entry, { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    expect(response.headers().location).toBe(target);
  });
}
