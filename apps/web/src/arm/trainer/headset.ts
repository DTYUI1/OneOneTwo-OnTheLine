// Проверка гарнитуры перед тренировкой (TC-14, contracts/headset-check.md): чистые правила
// без браузера и сети. Что сказать после фразы — решает `headsetVerdict`.

import { loudnessNote, type Loudness } from "../softphone/voiceReport";

export const HEADSET_PHRASE = "Проверка связи, меня слышно.";

export interface HeadsetReply {
  readonly text: string;
  readonly confidence: number | null;
  readonly loudness: Loudness | null;
}

export interface HeadsetVerdict {
  /** Микрофон слышит и распознаёт: можно начинать. */
  readonly ok: boolean;
  /** «Вы сказали: «…»»; `null` — речи не расслышано. */
  readonly said: string | null;
  readonly note: string;
}

export function headsetVerdict(reply: HeadsetReply): HeadsetVerdict {
  const text = reply.text.trim();
  if (!text)
    return {
      ok: false,
      said: null,
      note: "Речи не расслышано. Скажите фразу ближе к микрофону и повторите.",
    };
  const loud = loudnessNote(reply.loudness);
  return {
    ok: loud === null,
    said: `Вы сказали: «${text}»`,
    note: loud ?? "Микрофон работает.",
  };
}
