// Запись доклада. Микрофон может быть недоступен (нет гарнитуры, нет HTTPS,
// отказ в разрешении) — это штатный режим, а не ошибка обучаемого: звонок
// всё равно засчитывается по факту, времени и адресату (`expected_call`).

import { createVoiceMeter, type VoiceMeter } from "./speech";

/** Контракт: multipart-поле `audio`, WAV/WebM/Ogg, не более 10 МиБ. */
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

const MIME_PREFERENCE = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/wav",
] as const;

export interface RecordingEnvironment {
  readonly secureContext: boolean;
  readonly mediaDevices: boolean;
  readonly mediaRecorder: boolean;
}

export interface RecordingStatus {
  readonly available: boolean;
  /** Спокойная строка для обучаемого; `null`, когда всё в порядке. */
  readonly note: string | null;
}

const READY: RecordingStatus = { available: true, note: null };

/** Чистая проверка окружения — тестируется без браузера. */
export function recordingStatus(env: RecordingEnvironment): RecordingStatus {
  if (!env.mediaRecorder || !env.mediaDevices)
    return {
      available: false,
      note: "Браузер не записывает звук. Звонок засчитается по факту, времени и адресату.",
    };
  if (!env.secureContext)
    return {
      available: false,
      note: "Микрофон работает только по защищённому соединению. Звонок засчитается по факту, времени и адресату.",
    };
  return READY;
}

export function browserRecordingStatus(): RecordingStatus {
  if (typeof window === "undefined") return { available: false, note: null };
  return recordingStatus({
    secureContext: window.isSecureContext,
    mediaDevices: Boolean(navigator.mediaDevices?.getUserMedia),
    mediaRecorder: typeof MediaRecorder !== "undefined",
  });
}

/** Первый поддерживаемый формат из контрактного списка. */
export function pickMimeType(
  supported: (type: string) => boolean,
): string | undefined {
  return MIME_PREFERENCE.find((type) => supported(type));
}

export interface Recording {
  readonly blob: Blob | null;
  readonly note: string | null;
}

export interface Recorder {
  /** Возвращает строку-пояснение, если записи не будет. */
  start(): Promise<string | null>;
  stop(): Promise<Recording>;
  release(): void;
  /** Последняя речь в микрофоне за этот разговор; `null` — не было или не слышно. */
  lastVoiceAt(): number | null;
}

export function createRecorder(): Recorder {
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let meter: VoiceMeter | null = null;

  function release(): void {
    meter?.close();
    meter = null;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    recorder = null;
    chunks = [];
  }

  return {
    async start(): Promise<string | null> {
      const status = browserRecordingStatus();
      if (!status.available) return status.note;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Тот же поток слушает бригада: она не перебивает диспетчера (speech.ts).
        meter = createVoiceMeter(stream);
        const mimeType = pickMimeType((type) =>
          MediaRecorder.isTypeSupported(type),
        );
        recorder = new MediaRecorder(
          stream,
          mimeType ? { mimeType } : undefined,
        );
        chunks = [];
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunks.push(event.data);
        };
        recorder.start();
        return null;
      } catch {
        release();
        return "Доступ к микрофону не выдан. Звонок засчитается по факту, времени и адресату.";
      }
    },

    async stop(): Promise<Recording> {
      const active = recorder;
      if (!active || active.state === "inactive") {
        release();
        return { blob: null, note: null };
      }
      const blob = await new Promise<Blob>((resolve) => {
        active.onstop = () =>
          resolve(new Blob(chunks, { type: active.mimeType || "audio/webm" }));
        active.stop();
      });
      release();
      if (blob.size === 0) return { blob: null, note: null };
      if (blob.size > MAX_AUDIO_BYTES)
        return {
          blob: null,
          note: "Запись длиннее допустимой и не отправлена. Звонок засчитан по факту, времени и адресату.",
        };
      return { blob, note: null };
    },

    release,

    lastVoiceAt: () => meter?.lastVoiceAt() ?? null,
  };
}
