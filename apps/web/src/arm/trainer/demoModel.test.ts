import { describe, expect, it } from "vitest";
import { demoComment, demoStatus, readMs, STATUS_SAY } from "./demoModel";

describe("показ «Смотрю» — правила курсора", () => {
  it("статус шага проводника: решение — «Принята», ход дела — тот же статус", () => {
    expect(demoStatus("decide", false)).toBe("accepted");
    expect(demoStatus("brigade", true)).toBe("accepted");
    expect(demoStatus("responding", false)).toBe("responding");
    expect(demoStatus("completed", false)).toBe("completed");
    expect(demoStatus("report", false)).toBeNull();
    expect(demoStatus(null, false)).toBeNull();
  });

  it("у каждого статуса показа есть слова", () => {
    for (const step of [
      "decide",
      "responding",
      "arrived",
      "working",
      "completed",
    ]) {
      const status = demoStatus(step, false);
      expect(status && STATUS_SAY[status]).toBeTruthy();
    }
  });

  it("комментарий: при «Принята» — решение и суть карточки, дальше — доклад бригады", () => {
    expect(demoComment("accepted", "Пожар. Тверская, 1", "Выехали")).toBe(
      "Принята к исполнению. Пожар. Тверская, 1",
    );
    expect(demoComment("arrived", "Пожар", "Прибыли на место")).toBe(
      "Прибыли на место",
    );
    expect(demoComment("arrived", "Пожар", null)).toBe("Пожар");
  });

  it("пауза на прочтение — не меньше 1,6 с", () => {
    expect(readMs("да")).toBe(1600);
    expect(readMs("а".repeat(100))).toBe(5500);
  });
});
