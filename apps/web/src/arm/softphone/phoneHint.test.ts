import { describe, expect, it } from "vitest";
import { type PhoneSituation, phoneHint } from "./phoneHint";

const idle: PhoneSituation = {
  finished: false,
  call: "idle",
  aborted: false,
  callee: null,
  withBrigade: false,
  refusal: null,
  refusalAdvice: null,
  decided: true,
  panelOpen: false,
  brigadesAvailable: true,
  brigadesSent: 0,
  reportsAccepted: 0,
  report: "none",
};

const brigadeCall: PhoneSituation = {
  ...idle,
  call: "talking",
  callee: "Учебный старший бригады 1",
  withBrigade: true,
  panelOpen: true,
  brigadesSent: 1,
};

describe("phoneHint", () => {
  it("свободная линия и закрытая панель — куда нажать", () => {
    expect(phoneHint(idle).next).toContain("«Телефон»");
  });

  it("раскрытая панель — где выбрать службу и бригады", () => {
    const hint = phoneHint({ ...idle, panelOpen: true });
    expect(hint.next).toContain("слева");
    expect(hint.next).toContain("Бригады");
  });

  it("без справочника бригад о бригадах не говорит", () => {
    const hint = phoneHint({
      ...idle,
      panelOpen: true,
      brigadesAvailable: false,
    });
    expect(hint.next).not.toContain("Бригады");
  });

  it("бригада направлена, но не звонили — позвонить ей", () => {
    const hint = phoneHint({ ...idle, brigadesSent: 1 });
    expect(hint.next).toContain("Позвоните бригаде");
  });

  it("до первого доклада обещает доклад", () => {
    expect(phoneHint(brigadeCall).next).toContain("доложит");
  });

  it("после первого доклада ничего не обещает — сколько их будет, знает сервер", () => {
    const hint = phoneHint({ ...brigadeCall, reportsAccepted: 3 });
    expect(hint.next).not.toContain("доложит");
    expect(hint.next).toContain("комментарий");
  });

  it("звучащий доклад засчитывается только целиком", () => {
    const hint = phoneHint({ ...brigadeCall, report: "audio" });
    expect(hint.next).toContain("целиком");
  });

  it("текстовый доклад — прочитать и подтвердить кнопкой", () => {
    const hint = phoneHint({ ...brigadeCall, report: "text" });
    expect(hint.next).toContain("«Принял» в окне разговора");
  });

  it("разговор со службой — что сказать и как закончить", () => {
    const hint = phoneHint({ ...idle, call: "talking", callee: "Служба 102" });
    expect(hint.now).toBe("На связи: Служба 102.");
    expect(hint.next).toContain("«Положить трубку»");
  });

  it("после ошибочного отказа объясняет путь к выезду бригады", () => {
    const hint = phoneHint({ ...idle, call: "talking", decided: false });
    expect(hint.next).toContain("«Принята»");
    expect(hint.next).toContain("прямому номеру");
  });

  it("сброшенный вызов назван сброшенным", () => {
    const hint = phoneHint({ ...idle, call: "ended", aborted: true });
    expect(hint.now).toBe("Вызов сброшен.");
  });

  it("после разговора с докладами — перенести их в комментарий", () => {
    const hint = phoneHint({ ...idle, call: "ended", reportsAccepted: 2 });
    expect(hint.next).toContain("комментарий");
  });

  it("завершённое занятие важнее состояния звонка", () => {
    const hint = phoneHint({ ...brigadeCall, finished: true });
    expect(hint.now).toBe("Занятие завершено.");
  });

  it("до решения по карточке объясняет, когда направлять бригаду", () => {
    const hint = phoneHint({ ...idle, panelOpen: true, decided: false });
    expect(hint.next).toContain("«Принята»");
  });

  it("ненаправленная бригада отказала — совет тот же, что под телефоном", () => {
    const advice =
      "Бригада не направлена на это происшествие — доклада не будет.";
    const hint = phoneHint({
      ...brigadeCall,
      refusal: "not_assigned",
      refusalAdvice: advice,
    });
    expect(hint.now).toContain("не направлена");
    expect(hint.next).toBe(advice);
  });

  it("занятая бригада отказала — сказано, что она занята", () => {
    const hint = phoneHint({ ...brigadeCall, call: "ended", refusal: "busy" });
    expect(hint.now).toContain("занята");
    expect(hint.next).toContain("не будет");
  });
});
