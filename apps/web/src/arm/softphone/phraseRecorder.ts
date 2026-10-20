// Запись одной фразы доклада с микрофона (DT-05). Микрофон открывается на фразу и сразу
// закрывается: индикатор записи в браузере не горит весь разговор. Отказ браузера —
// штатный путь: причина приходит словом (voiceReport.VoiceProblem), а не исключением.

import {
  accessProblem,
  environmentProblem,
  MAX_PHRASE_MS,
  speechLevel,
  type VoiceProblem,
} from "./voiceReport";

/** Контракт: multipart-поле `audio`, WAV/WebM/Ogg, не более 10 МиБ. */
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

const MIME_PREFERENCE = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/wav",
] as const;

/** Первый поддерживаемый формат из контрактного списка. */
export function pickMimeType(
  supported: (type: string) => boolean,
): string | undefined {
  return MIME_PREFERENCE.find((type) => supported(type));
}

export function browserProblem(): VoiceProblem | null {
  if (typeof window === "undefined") return "no_recorder";
  return environmentProblem({
    secureContext: window.isSecureContext,
    mediaDevices: Boolean(navigator.mediaDevices?.getUserMedia),
    mediaRecorder: typeof MediaRecorder !== "undefined",
  });
}

export interface PhraseRecorder {
  /** Открыть микрофон и начать запись; `null` — пишет, иначе причина, почему нет. */
  start(onLimit: () => void): Promise<VoiceProblem | null>;
  /** Остановить и отдать фразу; пустая или слишком длинная — `null`. */
  stop(): Promise<Blob | null>;
  /** Бросить запись без результата (отбой, конец занятия). */
  cancel(): void;
  /** Громкость с микрофона сейчас, 0…1; не пишет или анализ недоступен — 0. */
  level(): number;
}

export function createPhraseRecorder(): PhraseRecorder {
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let limit: ReturnType<typeof setTimeout> | null = null;
  let audio: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let samples: Float32Array<ArrayBuffer> | null = null;

  function release(): void {
    if (limit !== null) clearTimeout(limit);
    limit = null;
    void audio?.close().catch(() => undefined);
    audio = null;
    analyser = null;
    samples = null;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    recorder = null;
    chunks = [];
  }

  return {
    async start(onLimit) {
      const problem = browserProblem();
      if (problem) return problem;
      try {
        // Без автоусиления: иначе браузер выравнивает тихое и громкое, и громкость доклада
        // не оценить (evalcore.loudness). Шумо- и эхоподавление оставлены.
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            autoGainControl: false,
            noiseSuppression: true,
            echoCancellation: true,
          },
        });
      } catch (error) {
        release();
        return accessProblem(error);
      }
      const mimeType = pickMimeType((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.start();
      // Индикатор громкости: тот же поток, только чтение уровня — запись не меняется.
      if (typeof AudioContext !== "undefined") {
        try {
          audio = new AudioContext();
          analyser = audio.createAnalyser();
          analyser.fftSize = 1024;
          audio.createMediaStreamSource(stream).connect(analyser);
          samples = new Float32Array(analyser.fftSize);
        } catch {
          audio = null;
          analyser = null;
        }
      }
      // Забытая кнопка не пишет разговор до конца: фраза доклада короче.
      limit = setTimeout(onLimit, MAX_PHRASE_MS);
      return null;
    },

    async stop() {
      const active = recorder;
      if (!active || active.state === "inactive") {
        release();
        return null;
      }
      const blob = await new Promise<Blob>((resolve) => {
        active.onstop = () =>
          resolve(new Blob(chunks, { type: active.mimeType || "audio/webm" }));
        active.stop();
      });
      release();
      return blob.size > 0 && blob.size <= MAX_AUDIO_BYTES ? blob : null;
    },

    cancel() {
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        recorder.stop();
      }
      release();
    },

    level() {
      if (!analyser || !samples) return 0;
      analyser.getFloatTimeDomainData(samples);
      return speechLevel(samples);
    },
  };
}
