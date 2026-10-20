import { describe, expect, it } from "vitest";
import {
  lineForText,
  MENTOR_LINES,
  mentorText,
  voiceUrl,
} from "../../shared/mascot/mentorVoice";
import {
  BRIEF_TEXT,
  pointerTexts,
  pointerTip,
  WAIT_TEXT,
} from "../practice/pointer";
import { PENCIL_TEXT } from "../practice/pointerTarget";

// Голос наставника во «Вместе» находит реплику по тексту шага (mentorVoice.ts). Сменили текст
// подсказки — реплика потеряется молча, поэтому сверяем: каждый шаг есть в voice/lines.json и
// озвучен. Новые и изменённые реплики — scripts/voices/mascot_synth.py.

/**
 * Молчит: WAIT_TEXT в подсказке не показывается, «Выслушайте бригаду…» — пока говорит бригада,
 * вводная (BRIEF_TEXT) — когда говорит диспетчер: голос наставника попал бы в его микрофон.
 */
const silent = (text: string) =>
  text === WAIT_TEXT ||
  text === BRIEF_TEXT ||
  text.startsWith("Выслушайте бригаду");

const rejected = pointerTip({
  progress: {
    current: "decide",
    missed: [],
    done: new Set(),
    finished: false,
    rejected: true,
  },
  state: "rejected",
  missingReports: [],
  incoming: false,
});

describe("голос наставника во «Вместе»", () => {
  it("у каждого шага подсказки есть реплика", () => {
    const steps = [
      ...pointerTexts().filter((text) => !silent(text)),
      PENCIL_TEXT,
      rejected!.text,
    ];
    expect(steps.filter((text) => !lineForText(text))).toEqual([]);
  });

  it("у окон обучения есть реплики", () => {
    for (const id of ["greet", "watch-done", "together-done"])
      expect(mentorText(id)).not.toBe("");
  });

  it("произносится без кавычек: в этом голосе они дают паузу вокруг слова", () => {
    // Проверка капитана 18.10: «Мой путь», «Смотрю», «Сам» звучали с запинкой. На экране
    // кавычки остаются, в `speech` — «кнопка Мой путь», «статус Принята».
    expect(
      MENTOR_LINES.filter((line) => /[«»]/.test(line.speech ?? line.text)).map(
        (line) => line.id,
      ),
    ).toEqual([]);
  });

  it("реплики без повторов, и каждая озвучена", () => {
    expect(new Set(MENTOR_LINES.map((line) => line.id)).size).toBe(
      MENTOR_LINES.length,
    );
    expect(new Set(MENTOR_LINES.map((line) => line.text)).size).toBe(
      MENTOR_LINES.length,
    );
    expect(
      MENTOR_LINES.filter((line) => !voiceUrl(line.id)).map((line) => line.id),
    ).toEqual([]);
  });
});
