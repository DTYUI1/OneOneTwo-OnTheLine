import { expect, it } from "vitest";
import type { components } from "../../api-client/schema";
import { guideSession, screenHelpEnabled } from "./sessionGuide";
type Session = components["schemas"]["Session"];
const lesson = (
  id: string,
  hints: number,
  status: Session["status"] = "finished",
): Session => ({
  id,
  title: id,
  teacher_id: "teacher",
  status,
  participants: [
    {
      user_id: "trainee",
      workstation_number: 1,
      dds_service_id: "102",
      level: 1,
    },
  ],
  settings_snapshot: {
    reaction_normative_s: 30,
    handling_normative_s: 180,
    critical_cap: 0.5,
    parallel_cards: 1,
    hints_level: hints,
    spelling_hints: false,
    weights: { address: 1 },
  },
});
const old = lesson("ffffffff", 1);
const recent = lesson("00000000", 0);
const cards = [
  { session_id: old.id, appeared_at: "2026-09-26T10:00:00Z" },
  { session_id: recent.id, appeared_at: "2026-09-27T10:00:00Z" },
];
it("после завершения сохраняет уровень последнего занятия независимо от порядка UUID и ответа", () => {
  for (const sessions of [
    [old, recent],
    [recent, old],
  ])
    expect(
      guideSession(sessions, cards, "trainee")?.settings_snapshot.hints_level,
    ).toBe(0);
});
it("в старой карточке использует именно её снимок, а чужая карточка не даёт справку", () => {
  expect(
    guideSession([old, recent], cards, "trainee", old.id)?.settings_snapshot
      .hints_level,
  ).toBe(1);
  expect(guideSession([old, recent], cards, "other", old.id)).toBeUndefined();
});
it("новое начатое занятие действует даже до выдачи первой карточки", () => {
  const running = lesson("running", 1, "running");
  expect(guideSession([old, recent, running], cards, "trainee")).toBe(running);
});
it("«?» выключает только занятие преподавателя с подсказками 0", () => {
  expect(screenHelpEnabled(undefined)).toBe(true);
  expect(screenHelpEnabled(recent)).toBe(false);
  expect(screenHelpEnabled(old)).toBe(true);
  // Тренировка на ступени без подсказок: объяснение экрана всё равно есть.
  expect(screenHelpEnabled({ ...recent, kind: "practice" })).toBe(true);
});
