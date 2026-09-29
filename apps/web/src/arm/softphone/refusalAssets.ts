// Сгенерировано scripts/voices/refusal_manifest.py — руками не править.
// Отказ бригады, не направленной на происшествие (28.09): это не фраза Q14, поэтому
// не в VoiceManifest, а отдельной картой. Нет файла — текст с пометкой (voices.ts).

import type { Refusal } from "./machine";
import type { VoiceAsset } from "./voiceAssets";

import voice_1_busy from "./refusal/denis/busy.ogg?url";
import voice_1_not_assigned from "./refusal/denis/not_assigned.ogg?url";
import voice_2_busy from "./refusal/irina/busy.ogg?url";
import voice_2_not_assigned from "./refusal/irina/not_assigned.ogg?url";
import voice_3_busy from "./refusal/dmitri/busy.ogg?url";
import voice_3_not_assigned from "./refusal/dmitri/not_assigned.ogg?url";
import voice_4_busy from "./refusal/ruslan/busy.ogg?url";
import voice_4_not_assigned from "./refusal/ruslan/not_assigned.ogg?url";

export const REFUSAL_ASSETS: Record<
  string,
  Partial<Record<Refusal, VoiceAsset>>
> = {
  "voice-1": {
    busy: {
      url: voice_1_busy,
      durationMs: 2020,
      text: "Мы заняты на другом происшествии",
    },
    not_assigned: {
      url: voice_1_not_assigned,
      durationMs: 1881,
      text: "Нам этот вызов не назначен",
    },
  },
  "voice-2": {
    busy: {
      url: voice_2_busy,
      durationMs: 2566,
      text: "Мы заняты на другом происшествии",
    },
    not_assigned: {
      url: voice_2_not_assigned,
      durationMs: 1997,
      text: "Нам этот вызов не назначен",
    },
  },
  "voice-3": {
    busy: {
      url: voice_3_busy,
      durationMs: 1695,
      text: "Мы заняты на другом происшествии",
    },
    not_assigned: {
      url: voice_3_not_assigned,
      durationMs: 1509,
      text: "Нам этот вызов не назначен",
    },
  },
  "voice-4": {
    busy: {
      url: voice_4_busy,
      durationMs: 1892,
      text: "Мы заняты на другом происшествии",
    },
    not_assigned: {
      url: voice_4_not_assigned,
      durationMs: 2148,
      text: "Нам этот вызов не назначен",
    },
  },
};
