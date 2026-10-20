// Сгенерировано scripts/voices/manifest.py — руками не править.
// Реплики едут в бандле: своего эндпоинта для них в контракте нет.

import type { Phrase } from "./voices";

import voice_1_accepted from "./voices/phone/denis/accepted.ogg?url";
import voice_1_listen from "./voices/phone/denis/listen.ogg?url";
import voice_2_accepted from "./voices/phone/irina/accepted.ogg?url";
import voice_2_listen from "./voices/phone/irina/listen.ogg?url";
import voice_3_accepted from "./voices/phone/dmitri/accepted.ogg?url";
import voice_3_listen from "./voices/phone/dmitri/listen.ogg?url";
import voice_4_accepted from "./voices/phone/ruslan/accepted.ogg?url";
import voice_4_listen from "./voices/phone/ruslan/listen.ogg?url";

export interface VoiceAsset {
  readonly url: string;
  readonly durationMs: number;
  /** Что звучит в файле дословно — в роде голоса («понял» / «поняла»). */
  readonly text: string;
}

export const VOICE_ASSETS: Record<string, Record<Phrase, VoiceAsset>> = {
  "voice-1": {
    accepted: {
      url: voice_1_accepted,
      durationMs: 2868,
      text: "Я вас понял, информация принята",
    },
    listen: { url: voice_1_listen, durationMs: 1429, text: "Слушаю вас" },
  },
  "voice-2": {
    accepted: {
      url: voice_2_accepted,
      durationMs: 3240,
      text: "Я вас поняла, информация принята",
    },
    listen: { url: voice_2_listen, durationMs: 1708, text: "Слушаю вас" },
  },
  "voice-3": {
    accepted: {
      url: voice_3_accepted,
      durationMs: 2555,
      text: "Я вас понял, информация принята",
    },
    listen: { url: voice_3_listen, durationMs: 1336, text: "Слушаю вас" },
  },
  "voice-4": {
    accepted: {
      url: voice_4_accepted,
      durationMs: 2543,
      text: "Я вас понял, информация принята",
    },
    listen: { url: voice_4_listen, durationMs: 1650, text: "Слушаю вас" },
  },
};
