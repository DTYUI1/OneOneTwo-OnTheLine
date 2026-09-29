// Сгенерировано scripts/voices/manifest.py — руками не править.
// Реплики едут в бандле: своего эндпоинта для них в контракте нет.

import type { Phrase } from "./voices";

import voice_1_accepted from "./voices/denis/accepted.ogg?url";
import voice_1_listen from "./voices/denis/listen.ogg?url";
import voice_2_accepted from "./voices/irina/accepted.ogg?url";
import voice_2_listen from "./voices/irina/listen.ogg?url";
import voice_3_accepted from "./voices/dmitri/accepted.ogg?url";
import voice_3_listen from "./voices/dmitri/listen.ogg?url";
import voice_4_accepted from "./voices/ruslan/accepted.ogg?url";
import voice_4_listen from "./voices/ruslan/listen.ogg?url";

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
      durationMs: 2368,
      text: "Я вас понял, информация принята",
    },
    listen: { url: voice_1_listen, durationMs: 929, text: "Слушаю вас" },
  },
  "voice-2": {
    accepted: {
      url: voice_2_accepted,
      durationMs: 2740,
      text: "Я вас поняла, информация принята",
    },
    listen: { url: voice_2_listen, durationMs: 1207, text: "Слушаю вас" },
  },
  "voice-3": {
    accepted: {
      url: voice_3_accepted,
      durationMs: 2055,
      text: "Я вас понял, информация принята",
    },
    listen: { url: voice_3_listen, durationMs: 836, text: "Слушаю вас" },
  },
  "voice-4": {
    accepted: {
      url: voice_4_accepted,
      durationMs: 2043,
      text: "Я вас понял, информация принята",
    },
    listen: { url: voice_4_listen, durationMs: 1149, text: "Слушаю вас" },
  },
};
