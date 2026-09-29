// Бригада слушает диспетчера (замечание 28.09): доклад не звучит поверх его речи.
// Правило — чистая функция `reportMayStart`, уровень голоса — `createVoiceMeter`
// на том же потоке микрофона, что пишет разговор.

/** Раньше этого после ответа бригада не говорит: диспетчер успевает представиться. */
export const MIN_LISTEN_MS = 2000;
/** Дольше этого после ответа первый доклад не ждёт, даже если диспетчер говорит без пауз. */
export const MAX_LISTEN_MS = 5000;
/** Пауза в речи, после которой диспетчер считается договорившим. */
export const SILENCE_MS = 800;
/** Сколько ждёт паузы доклад, пришедший позже окна слушания. */
export const HOLD_MS = 1500;
/** Среднеквадратичный уровень сигнала микрофона (−1…1), выше которого идёт речь. */
export const VOICE_RMS = 0.02;
/** Общий адресат отвечает после доклада и паузы; шум от своей реплики не считается. */
export const SERVICE_REPLY_SILENCE_MS = 1200;
export const SERVICE_REPLY_AFTER_GREETING_MS = 250;

export interface ListenInput {
  readonly now: number;
  /** Ответ на звонок: с этого момента бригада слушает. */
  readonly talkStartedAt: number;
  /** Когда доклад стал известен браузеру. */
  readonly reportSeenAt: number;
  /** Последний момент речи в микрофоне; `null` — речи не было или микрофона нет. */
  readonly lastVoiceAt: number | null;
}

/**
 * Можно ли начинать доклад. Не раньше 2 с после ответа; дальше — как только
 * диспетчер замолчал; если он говорит без пауз — через 5 с после ответа, а
 * для доклада, пришедшего позже, — через 1,5 с после его прихода.
 */
export function reportMayStart(input: ListenInput): boolean {
  if (input.now - input.talkStartedAt < MIN_LISTEN_MS) return false;
  const quiet =
    input.lastVoiceAt === null || input.now - input.lastVoiceAt >= SILENCE_MS;
  if (quiet) return true;
  const deadline = Math.max(
    input.talkStartedAt + MAX_LISTEN_MS,
    input.reportSeenAt + HOLD_MS,
  );
  return input.now >= deadline;
}

/** Только пауза после услышанной речи: без микрофона завершение остаётся ручным. */
export function serviceReplyMayStart(input: {
  readonly now: number;
  readonly greetingEndedAt: number;
  readonly lastVoiceAt: number | null;
}): boolean {
  return (
    input.lastVoiceAt !== null &&
    input.lastVoiceAt >=
      input.greetingEndedAt + SERVICE_REPLY_AFTER_GREETING_MS &&
    input.now - input.lastVoiceAt >= SERVICE_REPLY_SILENCE_MS
  );
}

/** Среднеквадратичный уровень отсчётов. */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

export interface VoiceMeter {
  lastVoiceAt(): number | null;
  close(): void;
}

/** Следит за уровнем микрофона. Без Web Audio — `null`: бригада тогда ждёт только 2 с. */
export function createVoiceMeter(stream: MediaStream): VoiceMeter | null {
  if (typeof AudioContext === "undefined") return null;
  try {
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    void context.resume().catch(() => undefined);
    const samples = new Float32Array(analyser.fftSize);
    let last: number | null = null;
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      if (rms(samples) >= VOICE_RMS) last = Date.now();
    }, 100);
    return {
      lastVoiceAt: () => last,
      close() {
        clearInterval(timer);
        source.disconnect();
        void context.close().catch(() => undefined);
      },
    };
  } catch {
    return null;
  }
}
