// Показ экрана ученика преподавателю (HQ-017, решение Dani 18.10: без звука, 5 кадров/с).
// Ученик: getDisplayMedia → кадр на canvas (≤ 960 px) → JPEG → бинарный WebSocket /ws/screen.
// Преподаватель: тот же канал отдаёт 16 байт UUID ученика + JPEG, только последний кадр.
// Протокол — contracts/ws-events.md, «Показ экрана ученика преподавателю».

/** 5 кадров/с; сервер отбрасывает всё чаще 150 мс. */
export const FRAME_INTERVAL_MS = 200;
/** Таймер браузера дрожит: тик через 195 мс не должен терять кадр (иначе выйдет 2,5 кадра/с),
 * но и чаще серверных 150 мс слать нельзя. */
export const MIN_GAP_MS = 160;
/** Ширина кадра: плитке и крупному виду хватает, 10 учеников × 5 кадров/с ≈ 3 МБ/с. */
export const FRAME_WIDTH = 960;
export const JPEG_QUALITY = 0.6;
/** Сервер не принимает кадр больше 256 КиБ — нет смысла его слать. */
export const MAX_FRAME_BYTES = 256 * 1024;
/** Сеть не успевает: пропускаем кадр, а не копим очередь в браузере. */
export const MAX_BUFFERED_BYTES = 512 * 1024;

/** Коды закрытия /ws/screen, после которых показ окончен (не переподключаемся). */
export const SCREEN_CLOSE_FINAL = new Set([1000, 4000, 4400, 4403, 4404, 4409]);

export function screenSocketUrl(
  sessionId: string,
  base = window.location.href,
): URL {
  const url = new URL("/ws/screen", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("session_id", sessionId);
  return url;
}

/** Достаточно для отправки: настоящий WebSocket или подделка в тестах. */
export interface FrameSink {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: Blob): void;
  close(code?: number): void;
}

const OPEN = 1;

/**
 * Отправка кадров не чаще FRAME_INTERVAL_MS. Кадр пропускается, если прежний ещё
 * кодируется, сокет не открыт или сеть не разобрала очередь: преподавателю нужен
 * свежий кадр, а не все подряд. Начинает на паузе: шлёт, только когда сервер сообщил,
 * что преподаватель смотрит (screen.state sharing).
 */
export class ScreenPublisher {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private last = Number.NEGATIVE_INFINITY;
  private stopped = false;
  /** Преподаватель сейчас не смотрит (screen.state paused): кадры не снимаем и не шлём. */
  paused = true;
  sent = 0;
  skipped = 0;

  constructor(
    private grab: () => Promise<Blob | null>,
    private sink: FrameSink,
    private now: () => number = () => Date.now(),
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), FRAME_INTERVAL_MS);
    void this.tick();
  }

  async tick(): Promise<void> {
    if (this.stopped || this.paused) return;
    const now = this.now();
    if (
      this.busy ||
      now - this.last < MIN_GAP_MS ||
      this.sink.readyState !== OPEN ||
      this.sink.bufferedAmount > MAX_BUFFERED_BYTES
    ) {
      this.skipped += 1;
      return;
    }
    this.busy = true;
    this.last = now;
    try {
      const frame = await this.grab();
      if (
        frame &&
        frame.size <= MAX_FRAME_BYTES &&
        !this.stopped &&
        !this.paused
      ) {
        this.sink.send(frame);
        this.sent += 1;
      }
    } finally {
      this.busy = false;
    }
  }

  stop(code = 1000): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.sink.close(code);
  }
}

/** Кадр захвата → JPEG не шире FRAME_WIDTH. Звук не захватывается вовсе. */
export function canvasGrabber(stream: MediaStream): {
  grab: () => Promise<Blob | null>;
  dispose: () => void;
} {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  void video.play().catch(() => undefined);
  const canvas = document.createElement("canvas");
  return {
    grab: () =>
      new Promise((resolve) => {
        const width = video.videoWidth;
        const height = video.videoHeight;
        const context = canvas.getContext("2d");
        if (!width || !height || !context) return resolve(null);
        const scale = Math.min(1, FRAME_WIDTH / width);
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY);
      }),
    dispose: () => {
      video.srcObject = null;
      for (const track of stream.getTracks()) track.stop();
    },
  };
}

/** Спросить у браузера экран: окно выбора и есть согласие ученика. */
export function captureScreen(): Promise<MediaStream> {
  // preferCurrentTab: Chrome сразу предлагает вкладку АРМ — вся работа ученика в ней.
  const options: DisplayMediaStreamOptions & { preferCurrentTab?: boolean } = {
    video: { frameRate: 5 },
    audio: false,
    preferCurrentTab: true,
  };
  return navigator.mediaDevices.getDisplayMedia(options);
}

/** Строка ScreenShare из `GET /sessions/{id}/screens` (нужны только эти поля). */
export interface ShareRow {
  user_id: string;
  state: string;
}

/**
 * Состояние своего показа по `GET /sessions/{id}/screens` — после переподключения /ws
 * screen.state, пришедшие в обрыв, потеряны, и плашка берёт их отсюда. `watched`:
 * true — sharing, false — paused, undefined — сокет показа сервер ещё не видит (requested
 * или показа нет): тогда последнее известное не трогаем, сокет мог только открыться.
 */
export function ownShareState(
  shares: readonly ShareRow[] | undefined,
  userId: string,
): { requested: boolean; watched?: boolean } {
  const own = shares?.find((share) => share.user_id === userId);
  if (!own) return { requested: false };
  if (own.state === "sharing") return { requested: true, watched: true };
  if (own.state === "paused") return { requested: true, watched: false };
  return { requested: own.state !== "stopped" };
}

/** Бинарное сообщение преподавателю: 16 байт UUID ученика, дальше JPEG. */
export function parseFrame(
  data: ArrayBuffer,
): { userId: string; jpeg: Blob } | null {
  if (data.byteLength <= 16) return null;
  const hex = Array.from(new Uint8Array(data, 0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const userId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { userId, jpeg: new Blob([data.slice(16)], { type: "image/jpeg" }) };
}

/**
 * Приём кадров преподавателем. Обрыв сети — переподключение через 1…5 с;
 * конец занятия (4000) и отказ доступа — без повторов.
 */
export class ScreenViewer {
  private socket?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private backoff = 1000;
  private stopped = false;

  constructor(
    private sessionId: string,
    private onFrame: (userId: string, jpeg: Blob) => void,
  ) {}

  start(): void {
    if (this.stopped) return;
    const socket = new WebSocket(screenSocketUrl(this.sessionId));
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onopen = () => {
      this.backoff = 1000;
    };
    socket.onmessage = (message) => {
      if (!(message.data instanceof ArrayBuffer)) return;
      const frame = parseFrame(message.data);
      if (frame) this.onFrame(frame.userId, frame.jpeg);
    };
    socket.onclose = (closed) => {
      if (this.stopped || this.socket !== socket) return;
      if (closed.code === 4000 || closed.code === 4403 || closed.code === 4404)
        return;
      this.retry = setTimeout(() => this.start(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 5000);
    };
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.socket?.close();
    this.socket = undefined;
  }
}
