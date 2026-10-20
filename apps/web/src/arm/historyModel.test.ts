import { describe, expect, it } from "vitest";
import { buildHistory, type HistoryEvent } from "./historyModel";

const card = {
  id: "card-a",
  trainee_id: "trainee-a",
  appeared_at: "2026-10-19T10:00:00Z",
  delivered_at: "2026-10-19T10:00:03Z",
};
const event = (
  id: string,
  type: string,
  payload: Record<string, unknown> = {},
  at = "2026-10-19T10:00:10Z",
  actor = card.trainee_id,
): HistoryEvent => ({ id, type, payload, server_ts: at, actor_id: actor });
const rows = (events: HistoryEvent[]) =>
  buildHistory({ card, events, workstation: 3, traineeName: "Иван Петров" });


describe("История карточки АРМ", () => {
  it("использует подтверждённую доставку, а не открытие карточки", () => {
    const result = rows([]);
    expect(result.find((item) => item.label === "Получена службой")?.at).toBe(
      card.delivered_at,
    );
    expect(result[0].operator).toBe("Оператор 112");
  });

  it("не добавляет вторую доставку при наличии события журнала", () => {
    const result = rows([event("delivery", "deliver")]);
    expect(result.filter((item) => item.label === "Получена службой")).toHaveLength(1);
    expect(result.find((item) => item.label === "Получена службой")?.id).toBe("delivery");
  });

  it("сортирует записи по времени сервера и исключает повтор одного id", () => {
    const later = event("later", "comment", { comment: "Позже" });
    const earlier = event("earlier", "status_change", { state: "accepted" }, "2026-10-19T10:00:04Z");
    const result = rows([later, earlier, later]);
    expect(result.slice(-2).map((item) => item.id)).toEqual(["earlier", "later"]);
  });

  it("не приписывает действия другого участника текущему оператору", () => {
    const result = rows([event("other", "status_change", { state: "accepted" }, undefined, "teacher-a")]);
    const entry = result.find((item) => item.id === "other")!;
    expect(entry.operator).toBe("Участник");
    expect(entry.operatorTitle).toBe("teacher-a");
    expect(entry.operator).not.toContain("3");
  });

  it("сохраняет полный многострочный комментарий и адресата перенаправления", () => {
    const comment = "Первая строка\n" + "длинный текст ".repeat(100);
    const result = buildHistory({
      card,
      events: [event("redirect", "redirect", { service_id: "101", comment })],
      workstation: 3,
      services: [{ id: "101", name: "Пожарная охрана" }],
    });
    const entry = result.find((item) => item.id === "redirect")!;
    expect(entry.comment).toContain(comment);
    expect(entry.comment).toContain("Пожарная охрана");
  });

  it("отделяет технические действия от статусов и комментариев", () => {
    const result = rows([
      event("open", "open"),
      event("status", "status_change", { state: "accepted" }),
      event("note", "comment", { comment: "Уточнение" }),
    ]);
    expect(result.find((item) => item.id === "open")?.primary).toBe(false);
    expect(result.find((item) => item.id === "status")?.primary).toBe(true);
    expect(result.find((item) => item.id === "note")?.primary).toBe(true);
  });

  it("помечает только реальное опоздавшее первичное решение", () => {
    const result = buildHistory({
      card,
      events: [event("late", "status_change", { state: "rejected" })],
      workstation: 3,
      lateId: "late",
    });
    expect(result.find((item) => item.id === "late")?.late).toBe(true);
    expect(result[0].late).toBe(false);
  });
});
