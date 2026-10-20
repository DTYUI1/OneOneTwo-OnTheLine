import { describe, expect, it } from "vitest";
import { tutorProgress, type TutorEvent } from "./tutor";

const dial = (id: string, ext: string): TutorEvent => ({
  type: "call_dial",
  payload: { call_id: id, phone_ext: ext },
});
const answer = (id: string): TutorEvent => ({
  type: "call_answer",
  payload: { call_id: id },
});
const hangup = (id: string): TutorEvent => ({
  type: "call_hangup",
  payload: { call_id: id },
});
const brigades: TutorEvent = {
  type: "brigades_select",
  payload: { brigade_ids: ["b"] },
};

describe("tutorProgress", () => {
  it("начинает с решения по открытой карточке", () => {
    const result = tutorProgress({
      state: "received",
      events: [],
    });
    expect(result.current).toBe("decide");
    expect(result.done.has("open")).toBe(true);
  });

  it("после «Принята» ведёт к бригаде, затем к выезду — без звонка своей службе", () => {
    const base = { state: "accepted" as const };
    expect(tutorProgress({ ...base, events: [] }).current).toBe("brigade");
    expect(tutorProgress({ ...base, events: [brigades] }).current).toBe(
      "responding",
    );
    // GP-05: бригаду направляет вводная в разговоре с ней.
    const briefing: TutorEvent = {
      type: "brigade_briefing",
      payload: { call_id: "c0", mode: "parts", text: "Адрес. Повод" },
    };
    expect(tutorProgress({ ...base, events: [briefing] }).current).toBe(
      "responding",
    );
    // Звонок своей службе шага не добавляет и не нужен (GP-04).
    const ownCall = [brigades, dial("c1", "102"), answer("c1"), hangup("c1")];
    const progress = tutorProgress({ ...base, events: ownCall });
    expect(progress.current).toBe("responding");
    expect(progress.missed).toEqual([]);
  });

  it("идёт по статусам хода дела до завершения", () => {
    const events = [brigades, dial("c1", "102"), answer("c1"), hangup("c1")];
    const at = (state: "responding" | "arrived" | "working") =>
      tutorProgress({ state, events }).current;
    expect(at("responding")).toBe("arrived");
    expect(at("arrived")).toBe("working");
    expect(at("working")).toBe("completed");
    const end = tutorProgress({
      state: "completed",
      events,
    });
    expect(end).toMatchObject({ current: null, finished: true });
  });

  it("не держит на пропущенном шаге: идёт за статусом и напоминает о пропуске", () => {
    const result = tutorProgress({
      state: "arrived",
      events: [brigades],
    });
    expect(result.current).toBe("working");
    expect(result.missed).toEqual([]);
    const skipped = tutorProgress({ state: "arrived", events: [] });
    expect(skipped.missed).toEqual(["brigade"]);
  });

  it("без пропусков напоминаний нет", () => {
    const events = [brigades, dial("c1", "102"), answer("c1"), hangup("c1")];
    const result = tutorProgress({
      state: "responding",
      events,
    });
    expect(result.missed).toEqual([]);
  });

  it("отмечает «Не принята» и отказ бригады", () => {
    expect(tutorProgress({ state: "rejected", events: [] }).rejected).toBe(
      true,
    );
    expect(tutorProgress({ state: "refused", events: [] }).finished).toBe(true);
  });

  it("не требует ввода адреса: у ДДС адрес только для чтения (DT-14)", () => {
    const progress = tutorProgress({
      state: "accepted",
      events: [brigades],
    });
    expect(progress.missed).toEqual([]);
    expect(progress).not.toHaveProperty("addressMissing");
  });
});
