import { api, csrfToken, type CardEvent, type ServerEvent } from "../api";
import {
  BACKOFF_FIRST_MS,
  nextBackoff,
  ONLINE,
  type ConnectionState,
} from "./connection";
import { coalesce, flushOutbox, Outbox, type OutboxOutcome } from "./outbox";
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

/**
 * «Сейчас» по часам сервера (I-TIME): часы компьютера плюс поправка синхронизации
 * (`RealtimeClient.clockOffsetMs` = сервер − клиент). Сравнивать время из выдачи сервера
 * (сроки, моменты звонков) — только с ним: в классе компьютеры без интернета, их часы
 * расходятся на десятки секунд.
 */
export function serverNow(
  offsetMs: number,
  clientNow: number = Date.now(),
): number {
  return clientNow + offsetMs;
}

export function isServerEvent(value: unknown): value is ServerEvent {
  return validateServerEvent(value);
}

export class RealtimeClient {
  private socket?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private stopped = true;
  private backoff = BACKOFF_FIRST_MS;
  private outbox = new Outbox();
  private offset = 0;
  private outcomeListeners = new Set<(outcome: OutboxOutcome) => void>();
  private listeners = new Set<(event: ServerEvent) => void>();
  // Кто в сети (TC-12): сервер шлёт список сразу после snapshot, ещё до того, как доска
  // подпишется, — поэтому присутствие хранит клиент, а не подписчик.
  private online = new Set<string>();
  // Состояние связи для обучаемого (TC-08): строка «Работа не потеряна…» у верхнего края АРМ.
  private conn: ConnectionState = ONLINE;
  private connListeners = new Set<() => void>();
  private flushRetry?: ReturnType<typeof setTimeout>;
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
    window.addEventListener("offline", this.onBrowserOffline);
    window.addEventListener("online", this.onBrowserOnline);
    this.connect();
  }
  stop(): void {
    this.stopped = true;
    window.removeEventListener("offline", this.onBrowserOffline);
    window.removeEventListener("online", this.onBrowserOnline);
    clearTimeout(this.retry);
    clearTimeout(this.flushRetry);
    clearInterval(this.heartbeat);
    this.socket?.close();
    this.socket = undefined;
  }

  /** Кто сейчас в сети по событиям `presence` этого соединения. */
  onlineUsers(): ReadonlySet<string> {
    return new Set(this.online);
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Локальные результаты доставки, включая повторы; контракт ServerEvent не меняется. */
  subscribeOutcomes(listener: (outcome: OutboxOutcome) => void): () => void {
    this.outcomeListeners.add(listener);
    return () => {
      this.outcomeListeners.delete(listener);
    };
  }

  pending() {
    return this.outbox.list(this.userId);
  }

  /** Состояние связи; значение меняется целиком, подходит для useSyncExternalStore. */
  connection = (): ConnectionState => this.conn;

  subscribeConnection = (listener: () => void): (() => void) => {
    this.connListeners.add(listener);
    return () => {
      this.connListeners.delete(listener);
    };
  };

  /** «Повторить сейчас»: не ждать назначенной попытки — переподключиться и дослать очередь. */
  retryNow = (): void => {
    if (this.stopped) return;
    clearTimeout(this.retry);
    clearTimeout(this.flushRetry);
    this.backoff = BACKOFF_FIRST_MS;
    this.setConn({ ...this.conn, retryAt: null });
    const state = this.socket?.readyState;
    if (state !== WebSocket.OPEN && state !== WebSocket.CONNECTING) {
      this.socket = undefined;
      this.connect();
    }
    void this.flush();
  };

  private setConn(next: ConnectionState): void {
    if (
      next.online === this.conn.online &&
      next.since === this.conn.since &&
      next.retryAt === this.conn.retryAt
    )
      return;
    this.conn = next;
    for (const listener of this.connListeners) listener();
  }

  /** Связи нет; `delay` — через сколько следующая попытка. */
  private goOffline(delay: number): void {
    this.setConn({
      online: false,
      since: this.conn.online ? Date.now() : this.conn.since,
      retryAt: Date.now() + delay,
    });
  }

  private goOnline(): void {
    this.backoff = BACKOFF_FIRST_MS;
    this.setConn(ONLINE);
  }

  private onBrowserOffline = (): void => {
    if (!this.stopped) this.goOffline(this.backoff);
  };
  private onBrowserOnline = (): void => this.retryNow();

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
      let result;
      try {
        result = await api.POST("/cards/{id}/events", {
          params: {
            path: { id: item.cardId },
            header: { "X-CSRF-Token": csrfToken() },
          },
          body: item.event,
        });
      } catch (error) {
        // Сеть отказала при открытом сокете: очередь остаётся, попытка — по расписанию.
        this.fetchFailed();
        throw error;
      }
      const { response, error } = result;
      if (response.status < 500 && !this.conn.online && this.socketOpen())
        this.goOnline();
      return {
        status: response.status,
        message: error?.message,
        code: error?.code,
      };
    }, (outcome) => {
      for (const listener of this.outcomeListeners) {
        // Ошибка подписчика не должна прерывать сохранение очереди других карточек.
        try {
          listener(outcome);
        } catch {
          // Подписчик интерфейса изолирован от подтверждения доставки.
        }
      }
    });
  });

  private socketOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private fetchFailed(): void {
    if (this.stopped) return;
    const delay = this.backoff;
    this.backoff = nextBackoff(this.backoff);
    this.goOffline(delay);
    clearTimeout(this.flushRetry);
    this.flushRetry = setTimeout(() => {
      this.setConn({ ...this.conn, retryAt: null });
      void this.flush();
    }, delay);
  }

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
      this.backoff = BACKOFF_FIRST_MS;
      this.goOnline();
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
      if (event.type === "snapshot") this.online.clear();
      if (event.type === "presence") {
        if (event.payload.online) this.online.add(event.payload.user_id);
        else this.online.delete(event.payload.user_id);
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
      this.goOffline(this.backoff);
      this.retry = setTimeout(() => {
        this.setConn({ ...this.conn, retryAt: null });
        this.connect();
      }, this.backoff);
      this.backoff = nextBackoff(this.backoff);
    };
  }
}
