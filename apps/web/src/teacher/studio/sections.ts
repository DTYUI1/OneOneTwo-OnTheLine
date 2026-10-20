export const STUDIO_SECTIONS = [
  ["active", "Рабочие"],
  ["draft", "Черновики"],
  ["approved", "Утверждённые"],
  ["retired", "Архив"],
  ["packs", "Сгенерировать"],
] as const;

export type StudioSection = (typeof STUDIO_SECTIONS)[number][0];
