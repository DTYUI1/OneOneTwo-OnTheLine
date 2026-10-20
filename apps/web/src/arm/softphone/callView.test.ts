import { describe, expect, it } from "vitest";
import { phraseFor } from "./callView";

describe("phraseFor", () => {
  const brigadeTalk = {
    state: "talking" as const,
    inbound: true,
    withBrigade: true,
    spoken: null,
  };
  const report = "Бригада 2 выехала, прибытие через 7 минут";

  it("в разговоре с бригадой показывает её доклад крупной строкой", () => {
    expect(phraseFor(brigadeTalk, report)).toEqual({
      text: report,
      waiting: false,
    });
    expect(phraseFor({ ...brigadeTalk, inbound: false }, report).text).toBe(
      report,
    );
  });

  it("без доклада бригады — строка ожидания", () => {
    expect(phraseFor(brigadeTalk, null)).toEqual({
      text: "Бригада на связи — слушайте доклад",
      waiting: true,
    });
  });

  it("со службой доклад бригады не подставляется", () => {
    const service = {
      state: "talking" as const,
      inbound: false,
      withBrigade: false,
      spoken: "Слушаю вас",
    };
    expect(phraseFor(service, report)).toEqual({
      text: "Слушаю вас",
      waiting: false,
    });
  });

  it("до ответа доклад не показывается", () => {
    expect(
      phraseFor({ ...brigadeTalk, state: "ringing", inbound: false }, report),
    ).toEqual({ text: "Ждём ответа", waiting: true });
    expect(
      phraseFor({ ...brigadeTalk, state: "dialing", inbound: false }, report)
        .text,
    ).toBe("Соединение");
  });
});
