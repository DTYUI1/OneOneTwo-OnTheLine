import { describe, expect, it } from "vitest";
import {
  briefingAnswer,
  briefingSteps,
  briefingText,
  needsBriefing,
  type BriefingCheck,
} from "./briefing";

const source = {
  address: {
    city: "Москва",
    okrug: "САО",
    district: "Бескудниковский",
    street: "Бескудниковский бульвар",
    house: "24",
    building: "",
    apartment: "115",
  },
  incident_class: "задымление: квартира",
  description: "Из-под двери квартиры 115 идёт дым.",
};

const full: BriefingCheck = {
  address: "ok",
  heard_address: "Бескудниковский бульвар, 24",
  incident: true,
  complete: true,
  readback: "Повторяю: Бескудниковский бульвар, 24.",
  ask_again: null,
};

describe("вводная бригаде по частям", () => {
  it("адрес и повод: по три коротких варианта, верный из карточки", () => {
    const steps = briefingSteps(source, "call-1");
    expect(steps.map((step) => step.label)).toEqual(["Адрес", "Что случилось"]);
    for (const step of steps) {
      expect(step.options).toHaveLength(3);
      expect(step.options.filter((item) => item.correct)).toHaveLength(1);
      for (const item of step.options)
        expect(item.text.length).toBeLessThan(60);
    }
    const right = steps.map(
      (step) => step.options.find((item) => item.correct)!.text,
    );
    expect(briefingText(right)).toBe(
      "Бескудниковский бульвар, 24. задымление: квартира",
    );
  });

  it("ошибка адреса — буква в улице и цифра в доме", () => {
    const [address] = briefingSteps(source, "call-1");
    expect(
      address!.options
        .filter((item) => !item.correct)
        .map((item) => item.text)
        .sort(),
    ).toEqual(["Безкудниковский бульвар, 24", "Пескудниковский бульвар, 241"]);
  });

  it("без класса происшествия повод — описание карточки", () => {
    const [, incident] = briefingSteps(
      { ...source, incident_class: "" },
      "call-1",
    );
    expect(incident!.options.find((item) => item.correct)!.text).toBe(
      "Из-под двери квартиры 115 идёт дым",
    );
  });
});

describe("кому нужна вводная", () => {
  const base = {
    brigadeId: "b1",
    decided: true,
    refusal: false,
    dispatched: [] as string[],
  };

  it("свободной бригаде на линии после «Принята»", () => {
    expect(needsBriefing(base)).toBe(true);
  });

  it("не нужна: бригада уже выехала, отказ, нет решения, на линии служба", () => {
    expect(needsBriefing({ ...base, dispatched: ["b1"] })).toBe(false);
    expect(needsBriefing({ ...base, refusal: true })).toBe(false);
    expect(needsBriefing({ ...base, decided: false })).toBe(false);
    expect(needsBriefing({ ...base, brigadeId: null })).toBe(false);
  });
});

describe("ответ бригады на вводную", () => {
  it("полная — повтор адреса", () => {
    expect(briefingAnswer(full, "101")).toBe(full.readback);
  });

  it("ловушка повтора адреса — бригада молчит до доклада о выезде", () => {
    expect(briefingAnswer({ ...full, readback: null }, "101")).toBeNull();
  });

  it("неполная — переспрашивает недостающее", () => {
    expect(
      briefingAnswer(
        {
          ...full,
          address: "missing",
          heard_address: null,
          complete: false,
          readback: null,
          ask_again: "Не понял адрес. Назовите улицу и номер дома.",
        },
        "101",
      ),
    ).toBe("Не понял адрес. Назовите улицу и номер дома.");
    // Сервер не ответил — «не понял» фразой банка службы бригады.
    expect(briefingAnswer(null, "101")).toBe("Не понял, повторите.");
    expect(briefingAnswer(null, "103")).toBe("Не поняла, повторите.");
  });
});
