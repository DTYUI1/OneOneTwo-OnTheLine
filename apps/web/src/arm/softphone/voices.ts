// Реплики службы. Настоящие файлы Piper лежат в `data/voices/`, происхождение и
// лицензии — `scripts/voices/PROVENANCE.md`, пересборка — `scripts/voices/generate.sh`.
//
// Главное правило зоны: таймер не выдаётся за речь. Если звука не было, диалог не
// считается успешным — исход возвращается наружу и показывается человеку.

import type { Refusal } from "./machine";
import { REFUSAL_ASSETS } from "./refusalAssets";
import { VOICE_ASSETS, type VoiceAsset } from "./voiceAssets";

export type Phrase = "listen" | "accepted";

/** Всё, что говорит собеседник в разговоре: реплики Q14 и отказ бригады. */
export type Spoken = Phrase | Refusal;

/** Обязательные фразы Q&A Q14 и `data/voices/manifest.json` — мужской род по умолчанию. */
export const PHRASE_TEXT: Record<Phrase, string> = {
  listen: "Слушаю вас",
  accepted: "Я вас понял, информация принята",
};

/**
 * Отказ бригады, не направленной на происшествие (28.09). Это не фраза Q14: в
 * VoiceManifest (`contracts/storage.schema.json`) её нет, файлы — в `refusalAssets.ts`.
 * Обе фразы от «мы» — одинаковы для мужского и женского голоса.
 */
export const REFUSAL_TEXT: Record<Refusal, string> = {
  busy: "Мы заняты на другом происшествии",
  not_assigned: "Нам этот вызов не назначен",
};

function isRefusal(phrase: Spoken): phrase is Refusal {
  return phrase === "busy" || phrase === "not_assigned";
}

/**
 * Текст реплики дословно как звучит у этого голоса: в роде говорящего («понял» у
 * мужских голосов, «поняла» у женского). Экран не должен расходиться со звуком.
 */
export function phraseText(
  phrase: Spoken,
  voiceProfile: string | null,
): string {
  if (isRefusal(phrase)) return REFUSAL_TEXT[phrase];
  return assetFor(voiceProfile, phrase)?.text ?? PHRASE_TEXT[phrase];
}

/** Комфортная скорость чтения короткой строки на экране. */
const CHARS_PER_SECOND = 12;
const MIN_MS = 900;

export function phraseDurationMs(phrase: Spoken): number {
  const text = isRefusal(phrase) ? REFUSAL_TEXT[phrase] : PHRASE_TEXT[phrase];
  const seconds = text.length / CHARS_PER_SECOND;
  return Math.max(MIN_MS, Math.round(seconds * 1000));
}

/**
 * `played` — реплику слышно. `failed` — звука не было: файла нет, браузер не
 * пустил или устройство отказало. Текст показывается в обоих случаях, но
 * `failed` не выдаётся за состоявшийся разговор.
 */
export type VoiceOutcome = "played" | "failed";

export interface VoiceResult {
  readonly outcome: VoiceOutcome;
  /** Сколько прошло от вызова до реального начала звука, мс. Локальный файл, не VoIP. */
  readonly startedInMs: number | null;
  /** Что сказать человеку, если звука не было. */
  readonly note: string | null;
}

export interface Voices {
  /** Завершается, когда реплика отзвучала или стало ясно, что звука не будет. */
  play(phrase: Spoken, voiceProfile: string | null): Promise<VoiceResult>;
  /**
   * Учебное сообщение бригады: файл задан явно, а исходы те же. `readMs` —
   * сколько держать текст, если звука не будет.
   */
  playAsset(url: string | null, readMs: number): Promise<VoiceResult>;
  cancel(): void;
  setMuted(muted: boolean): void;
  setVolume(volume: number): void;
  readonly muted: boolean;
  readonly volume: number;
}

export function assetFor(
  voiceProfile: string | null,
  phrase: Spoken,
): VoiceAsset | null {
  if (!voiceProfile) return null;
  if (isRefusal(phrase)) return REFUSAL_ASSETS[voiceProfile]?.[phrase] ?? null;
  return VOICE_ASSETS[voiceProfile]?.[phrase] ?? null;
}

const NO_FILE = "Реплика службы не озвучена: нет файла для этого голоса.";
const BLOCKED =
  "Браузер не дал воспроизвести реплику — нажмите в окне и повторите.";
const DEVICE = "Устройство не воспроизвело реплику службы.";

export function createVoices(): Voices {
  let audio: HTMLAudioElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let muted = false;
  let volume = 1;

  function stop(): void {
    clearTimeout(timer);
    timer = undefined;
    if (!audio) return;
    // Снимаем источник, иначе элемент держит файл до сборки мусора.
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    audio = null;
  }

  /** Звука нет: текст держится столько же, сколько звучала бы речь. */
  function hold(readMs: number, note: string): Promise<VoiceResult> {
    return new Promise((resolve) => {
      timer = setTimeout(
        () => resolve({ outcome: "failed", startedInMs: null, note }),
        readMs,
      );
    });
  }

  /** Общий путь для реплик и сообщений: одни и те же исходы и одна отмена. */
  function start(
    url: string | null,
    readMs: number,
    missing: string | null,
  ): Promise<VoiceResult> {
    // Новый звук всегда отменяет предыдущий: двух одновременно не бывает.
    stop();
    if (!url) return hold(readMs, missing ?? NO_FILE);
    if (typeof Audio === "undefined") return hold(readMs, DEVICE);

    const started = Date.now();
    const element = new Audio(url);
    element.muted = muted;
    element.volume = volume;
    element.preload = "auto";
    audio = element;

    return new Promise<VoiceResult>((resolve) => {
      let startedInMs: number | null = null;
      const done = (result: VoiceResult) => {
        if (audio === element) stop();
        resolve(result);
      };
      element.addEventListener("playing", () => {
        startedInMs ??= Date.now() - started;
      });
      element.addEventListener("ended", () =>
        done({ outcome: "played", startedInMs, note: null }),
      );
      element.addEventListener("error", () =>
        done({ outcome: "failed", startedInMs: null, note: DEVICE }),
      );
      element.play().catch((reason: unknown) => {
        // NotAllowedError — политика автовоспроизведения, а не поломка.
        const blocked =
          reason instanceof DOMException && reason.name === "NotAllowedError";
        done({
          outcome: "failed",
          startedInMs: null,
          note: blocked ? BLOCKED : DEVICE,
        });
      });
    });
  }

  return {
    get muted() {
      return muted;
    },
    get volume() {
      return volume;
    },
    setMuted(next: boolean): void {
      muted = next;
      if (audio) audio.muted = next;
    },
    setVolume(next: number): void {
      volume = Math.min(1, Math.max(0, next));
      if (audio) audio.volume = volume;
    },
    play(phrase, voiceProfile): Promise<VoiceResult> {
      const asset = assetFor(voiceProfile, phrase);
      return start(
        asset?.url ?? null,
        phraseDurationMs(phrase),
        asset ? null : NO_FILE,
      );
    },
    playAsset(url, readMs): Promise<VoiceResult> {
      return start(url, readMs, url ? null : NO_FILE);
    },
    cancel(): void {
      stop();
    },
  };
}
