import { api, csrfToken, type CardEvent, type ServerEvent } from "../api";
import { coalesce, flushOutbox, Outbox } from "./outbox";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import contract from "../../../../../contracts/openapi.json";

const validator = new Ajv2020({ strict: false, allErrors: false });
addFormats(validator);
const validateServerEvent = validator.compile<ServerEvent>({
  components: contract.components,
  $ref: "#/components/schemas/WsServerEvent",
});

// Сервер отклоняет образец старше 60 с (TimingPolicy.max_sample_age_ms); берём с запасом.
const SAMPLE_MAX_AGE_MS = 55_000;

export function clockOffset(
  clientSent: number,
  clientReceived: number,
  serverTime: number,
): number {
  return serverTime - (clientSent + clientReceived) / 2;
}

export function isServerEvent(value: unknown): value is ServerEvent {
  return validateServerEvent(value);
}

export class RealtimeClient {
  private socket?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private stopped = true;
  private backoff = 500;
  private outbox = new Outbox();
  private offset = 0;
  private listeners = new Set<(event: ServerEvent) => void>();
  // Синхронизация часов v2 (I-TIME, C-02): отправленные ping и последний подтверждённый образец.
  // POST /clock/samples — только для trainee (contracts/openapi.draft.yaml x-roles),
  // остальным ролям образец не нужен и сервер честно отвечает 403 — клиент узнаёт свою
  // роль сам (/auth/me), не полагаясь на то, что каждый вызывающий её передаст.
  private clockV2 = false;
  private pendingPings = new Map<string, string>();
  private sample?: { id: string; receivedAt: number };

  constructor(
    private userId: string,
    private receive: (event: ServerEvent) => void,
  ) {}

  get clockOffsetMs(): number {
    return this.offset;
  }

  private async loadRole(): Promise<void> {
    let data;
    try {
      ({ data } = await api.GET("/auth/me"));
    } catch {
      // Запрос обрывается при уходе со страницы — часы остаются в прежнем режиме.
      return;
    }
    this.clockV2 = data?.role === "trainee";
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.loadRole();
    this.connect();
  }
  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    this.socket?.close();
    this.socket = undefined;
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  pending() {
    return this.outbox.list(this.userId);
  }

  async discardBlockedCard(cardId: string): Promise<number> {
    const removed = await this.outbox.discardBlockedCard(this.userId, cardId);
    if (removed) await this.flush();
    return removed;
  }

  async enqueue(cardId: string, event: CardEvent): Promise<void> {
    await this.outbox.add(this.userId, cardId, this.withClockSample(event));
    await this.flush();
  }

  /** Событие ссылается на свежий подтверждённый образец часов (возраст ≤ 60 с на сервере). */
  private withClockSample(event: CardEvent): CardEvent {
    const fresh =
      this.sample !== undefined &&
      Date.now() - this.sample.receivedAt <= SAMPLE_MAX_AGE_MS;
    if (!fresh || event.clock_sample_id) return event;
    return { ...event, clock_sample_id: this.sample!.id };
  }

  private async confirmSample(
    sampleId: string,
    serverTs: string,
  ): Promise<void> {
    const sent = this.pendingPings.get(sampleId);
    this.pendingPings.delete(sampleId);
    const serverTime = Date.parse(serverTs);
    if (sent === undefined || !Number.isFinite(serverTime)) return;
    const received = Date.now();
    const { data } = await api.POST("/clock/samples", {
      params: { header: { "X-CSRF-Token": csrfToken() } },
      body: {
        sample_id: sampleId,
        method: "ws_midpoint_v2",
        client_sent_at: sent,
        server_at: new Date(serverTime).toISOString(),
        client_received_at: new Date(received).toISOString(),
        offset_ms: clockOffset(Date.parse(sent), received, serverTime),
      },
    });
    if (data?.accepted) this.sample = { id: sampleId, receivedAt: received };
  }

  // Вызов во время идущей отправки не теряется: см. coalesce в outbox.ts.
  private flushQueue = coalesce(async () => {
    if (this.stopped) return;
    await flushOutbox(this.outbox, this.userId, async (item) => {
      if (this.stopped) return { status: 401 };
      const { response, error } = await api.POST("/cards/{id}/events", {
        params: {
          path: { id: item.cardId },
          header: { "X-CSRF-Token": csrfToken() },
        },
        body: item.event,
      });
      return {
        status: response.status,
        message: error?.message,
        code: error?.code,
      };
    });
  });

  private flush(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.flushQueue();
  }

  private connect(): void {
    if (this.stopped) return;
    const url = new URL("/ws", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      if (this.stopped || this.socket !== socket) {
        socket.close();
        return;
      }
      this.backoff = 500;
      const ping = () => {
        socket.send(
          JSON.stringify({
            type: "clock.ping",
            client_ts: new Date().toISOString(),
          }),
        );
        if (!this.clockV2) return;
        const sampleId = crypto.randomUUID();
        const sent = new Date().toISOString();
        this.pendingPings.set(sampleId, sent);
        socket.send(
          JSON.stringify({
            type: "clock.ping.v2",
            sample_id: sampleId,
            client_ts: sent,
          }),
        );
      };
      ping();
      this.heartbeat = setInterval(() => {
        ping();
        void this.flush();
      }, 5000);
      void this.flush();
    };
    socket.onmessage = (message) => {
      if (this.stopped || this.socket !== socket) return;
      let event: unknown;
      try {
        event = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (!isServerEvent(event)) return;
      if (event.type === "clock.pong.v2")
        void this.confirmSample(event.payload.sample_id, event.server_ts);
      if (event.type === "clock.pong") {
        const sent = Date.parse(event.payload.client_ts);
        const serverTime = Date.parse(event.server_ts);
        if (Number.isFinite(sent) && Number.isFinite(serverTime))
          this.offset = clockOffset(sent, Date.now(), serverTime);
      }
      this.receive(event);
      for (const listener of this.listeners) listener(event);
    };
    socket.onclose = (closed) => {
      if (this.socket !== socket) return;
      // 4400 на ping v2: сервер (mock) ещё не поддерживает часы v2 — продолжаем на v1.
      if (closed.code === 4400) this.clockV2 = false;
      this.pendingPings.clear();
      clearInterval(this.heartbeat);
      if (this.stopped) return;
      this.retry = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 5000);
    };
  }
}
