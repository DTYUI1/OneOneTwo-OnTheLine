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
const address: TutorEvent = {
  type: "field_change",
  payload: { field: "address", value: "ул. Тверская, 1" },
};
const brigades: TutorEvent = {
  type: "brigades_select",
  payload: { brigade_ids: ["b"] },
};

describe("tutorProgress", () => {
  it("начинает с решения по открытой карточке", () => {
    const result = tutorProgress({
      state: "received",
      events: [],
      servicePhone: "102",
    });
    expect(result.current).toBe("decide");
    expect(result.done.has("open")).toBe(true);
  });

  it("после «Принята» ведёт к бригаде, затем к докладу службе", () => {
    const base = { state: "accepted" as const, servicePhone: "102" };
    expect(tutorProgress({ ...base, events: [] }).current).toBe("brigade");
    expect(tutorProgress({ ...base, events: [brigades] }).current).toBe(
      "report",
    );
  });

  it("доклад службе засчитывается только за законченный разговор с её номером", () => {
    const base = { state: "accepted" as const, servicePhone: "102" };
    const unanswered = [brigades, dial("c1", "102")];
    expect(tutorProgress({ ...base, events: unanswered }).current).toBe(
      "report",
    );
    const brigadeCall = [
      brigades,
      dial("c2", "205"),
      answer("c2"),
      hangup("c2"),
    ];
    expect(tutorProgress({ ...base, events: brigadeCall }).current).toBe(
      "report",
    );
    // Служба ответила, обучаемый ещё докладывает — шаг не убегает вперёд.
    const talking = [...unanswered, answer("c1")];
    const during = tutorProgress({ ...base, events: talking });
    expect(during.current).toBe("report");
    expect(during.done.has("report")).toBe(false);
    const reported = [...talking, hangup("c1")];
    const after = tutorProgress({ ...base, events: reported });
    expect(after.current).toBe("responding");
    expect(after.done.has("report")).toBe(true);
    // Отбой без ответа (вызов сброшен) докладом не считается.
    const dropped = [brigades, dial("c3", "102"), hangup("c3")];
    expect(tutorProgress({ ...base, events: dropped }).current).toBe("report");
    // Сервер закрыл звонок сам (call_end) — тоже конец разговора.
    const closed = [
      ...talking,
      { type: "call_end", payload: { call_id: "c1" } },
    ];
    expect(tutorProgress({ ...base, events: closed }).current).toBe(
      "responding",
    );
  });

  it("идёт по статусам хода дела до завершения", () => {
    const events = [brigades, dial("c1", "102"), answer("c1"), hangup("c1")];
    const at = (state: "responding" | "arrived" | "working") =>
      tutorProgress({ state, events, servicePhone: "102" }).current;
    expect(at("responding")).toBe("arrived");
    expect(at("arrived")).toBe("working");
    expect(at("working")).toBe("completed");
    const end = tutorProgress({
      state: "completed",
      events,
      servicePhone: "102",
    });
    expect(end).toMatchObject({ current: null, finished: true });
  });

  it("не держит на пропущенном шаге: идёт за статусом и напоминает о пропуске", () => {
    const result = tutorProgress({
      state: "arrived",
      events: [brigades],
      servicePhone: "102",
    });
    expect(result.current).toBe("working");
    expect(result.missed).toEqual(["report"]);
  });

  it("без пропусков напоминаний нет", () => {
    const events = [brigades, dial("c1", "102"), answer("c1"), hangup("c1")];
    const result = tutorProgress({
      state: "responding",
      events,
      servicePhone: "102",
    });
    expect(result.missed).toEqual([]);
  });

  it("отмечает «Не принята» и отказ бригады", () => {
    expect(
      tutorProgress({ state: "rejected", events: [], servicePhone: null })
        .rejected,
    ).toBe(true);
    expect(
      tutorProgress({ state: "refused", events: [], servicePhone: null })
        .finished,
    ).toBe(true);
  });

  it("напоминает про адрес после «Принята», пока он не вписан", () => {
    const at = (state: "received" | "accepted", events: TutorEvent[]) =>
      tutorProgress({ state, events, servicePhone: "102" }).addressMissing;
    expect(at("received", [])).toBe(false);
    expect(at("accepted", [])).toBe(true);
    expect(at("accepted", [address])).toBe(false);
    const other: TutorEvent = {
      type: "field_change",
      payload: { field: "comment", value: "x" },
    };
    expect(at("accepted", [other])).toBe(true);
  });
});
