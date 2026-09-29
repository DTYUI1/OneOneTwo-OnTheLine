import { describe, expect, it } from "vitest";
import { tutorProgress } from "./tutor";
import {
  ADDRESS_REMINDER,
  headlineVariants,
  reminderVariants,
  tutorHeadline,
  tutorReminders,
} from "./tutorLines";

describe("tutorReminders", () => {
  it("после «Принята» без адреса напоминает об адресе", () => {
    const progress = tutorProgress({
      state: "accepted",
      events: [],
      servicePhone: "102",
    });
    expect(tutorReminders(progress)).toEqual([ADDRESS_REMINDER]);
  });

  it("после завершения не напоминает ни о чём", () => {
    const progress = tutorProgress({
      state: "completed",
      events: [],
      servicePhone: "102",
    });
    expect(tutorReminders(progress)).toEqual([]);
  });
});

describe("reminderVariants — запас места под напоминание", () => {
  it("содержит каждую строку, которую проводник покажет по ходу дела", () => {
    const variants = reminderVariants();
    // Ход упражнения из замера layout-stability: принята → бригада → выезд.
    for (const state of ["accepted", "responding", "arrived"] as const) {
      const line = tutorReminders(
        tutorProgress({ state, events: [], servicePhone: "102" }),
      ).join("; ");
      expect(variants).toContain(line);
    }
    expect(variants).toContain(ADDRESS_REMINDER);
  });

  it("самая длинная строка включает пропущенные шаги и адрес", () => {
    const longest = reminderVariants().reduce((a, b) =>
      b.length > a.length ? b : a,
    );
    expect(longest).toContain("направьте бригаду");
    expect(longest).toContain("доложите диспетчеру службы");
    expect(longest).toContain(ADDRESS_REMINDER);
  });
});

describe("tutorHeadline", () => {
  it("строка текущего шага есть среди вариантов, под которые держим место", () => {
    const line = tutorHeadline(
      tutorProgress({ state: "accepted", events: [], servicePhone: "102" }),
    );
    expect(line?.strong).toBe("Шаг 3 из 8: Направьте бригаду.");
    expect(headlineVariants()).toContainEqual(line);
  });
});
