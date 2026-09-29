import { describe, expect, it } from "vitest";
import { phraseFor, shouldAutoCollapse, stripSummary } from "./callView";

describe("shouldAutoCollapse", () => {
  it("держит панель, пока направленная бригада не доложила", () => {
    expect(shouldAutoCollapse({ committed: 1, accepted: 0 })).toBe(false);
    expect(shouldAutoCollapse({ committed: 2, accepted: 1 })).toBe(false);
  });

  it("сворачивает, когда доклад принят или бригады не направлены", () => {
    expect(shouldAutoCollapse({ committed: 1, accepted: 1 })).toBe(true);
    expect(shouldAutoCollapse({ committed: 1, accepted: 3 })).toBe(true);
    expect(shouldAutoCollapse({ committed: 0, accepted: 0 })).toBe(true);
  });

  it("не сворачивает сброшенный вызов и то, что требует действия", () => {
    expect(
      shouldAutoCollapse({ committed: 0, accepted: 0, aborted: true }),
    ).toBe(false);
    expect(
      shouldAutoCollapse({ committed: 1, accepted: 1, attention: true }),
    ).toBe(false);
  });
});

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

describe("stripSummary", () => {
  it("при входящем вызове прячет итог прошлого разговора", () => {
    expect(
      stripSummary({ state: "ended", aborted: false, ringingIn: true }),
    ).toEqual({ label: "Телефон", showExt: false });
    expect(
      stripSummary({ state: "ended", aborted: true, ringingIn: true }),
    ).toEqual({ label: "Телефон", showExt: false });
  });

  it("без входящего показывает итог как раньше", () => {
    expect(
      stripSummary({ state: "ended", aborted: false, ringingIn: false }),
    ).toEqual({ label: "Звонок завершён", showExt: true });
    expect(
      stripSummary({ state: "ended", aborted: true, ringingIn: false }).label,
    ).toBe("Вызов сброшен");
    expect(
      stripSummary({ state: "talking", aborted: false, ringingIn: true }).label,
    ).toBe("Разговор");
  });
});
