import { describe, expect, it } from "vitest";
import {
  addItem,
  issuesFromServer,
  planIssues,
  requestIdFor,
  suggestPlan,
  toBatch,
  type PlanItem,
} from "./handoutModel";
import type { Scenario } from "./model";

const scenario = (id: string, service: string, level = 1): Scenario =>
  ({
    id,
    version: 2,
    level,
    target_service_id: service,
    status: "approved",
    card: { service_ids: [service] },
  }) as unknown as Scenario;

const seat102 = { user_id: "u1", dds_service_id: "102", level: 1 };
const seat101 = { user_id: "u2", dds_service_id: "101", level: 2 };
const timing = { firstDelayS: 10, intervalS: 60 };
let n = 0;
const key = () => `k${(n += 1)}`;

describe("адресная выдача", () => {
  it("своя служба — «по профилю», чужая — осознанное упражнение", () => {
    let plan: PlanItem[] = [];
    plan = addItem(plan, seat102, scenario("s-dtp", "102"), timing, "a");
    plan = addItem(plan, seat102, scenario("s-fire", "101"), timing, "b");
    expect(plan.map((item) => [item.mode, item.delayS])).toEqual([
      ["profile", 10],
      ["intentional_mismatch", 70],
    ]);
    expect(plan[0].scenarioVersion).toBe(2);
  });

  it("подбирает разным местам разные задания по службе и уровню", () => {
    const plan = suggestPlan(
      [seat102, seat101],
      [
        scenario("dtp1", "102", 1),
        scenario("dtp4", "102", 4),
        scenario("fire2", "101", 2),
        scenario("fire3", "101", 3),
      ],
      timing,
      key,
    );
    expect(plan.map((item) => [item.participantId, item.scenarioId])).toEqual([
      ["u1", "dtp1"],
      ["u2", "fire2"],
    ]);
    expect(plan.every((item) => item.mode === "profile")).toBe(true);
  });

  it("продолжает order места после уже выданных, а не с единицы", () => {
    const plan = [
      addItem([], seat102, scenario("a", "102"), timing, "x")[0],
      { ...addItem([], seat101, scenario("b", "101"), timing, "y")[0] },
    ];
    const plan2 = addItem(plan, seat102, scenario("c", "102"), timing, "z");
    const body = toBatch(plan2, [{ participant_id: "u1", order: 3 }], "rid");
    expect(body.request_id).toBe("rid");
    expect(body.items.map((item) => [item.participant_id, item.order])).toEqual(
      [
        ["u1", 4],
        ["u2", 1],
        ["u1", 5],
      ],
    );
    expect(body.items[0]).toMatchObject({
      delay_from_start_s: 10,
      delivery_mode: "profile",
      scenario_version: 2,
    });
  });

  it("не даёт заданию прийти раньше предыдущего того же места", () => {
    const plan = addItem(
      addItem([], seat102, scenario("a", "102"), timing, "p"),
      seat102,
      scenario("b", "102"),
      timing,
      "q",
    );
    plan[1] = { ...plan[1], delayS: 5 };
    expect(planIssues(plan).get("q")).toEqual([
      "Задание приходит раньше предыдущего: задержки по очереди не убывают.",
    ]);
    expect(planIssues(plan).has("p")).toBe(false);
  });

  it("повторяет request_id для того же плана и меняет для другого", () => {
    const ids = ["r1", "r2"];
    const newId = () => ids.shift()!;
    const body = { items: [] };
    const first = requestIdFor(body, null, newId);
    expect(requestIdFor(body, first, newId).requestId).toBe("r1");
    expect(
      requestIdFor({ items: [{ order: 1 }] } as never, first, newId).requestId,
    ).toBe("r2");
  });

  it("раскладывает 422 пачки по строкам плана", () => {
    const plan = addItem([], seat102, scenario("s", "101"), timing, "row0");
    const issues = issuesFromServer(plan, [
      {
        index: 0,
        field: "delivery_mode",
        code: "service_mismatch",
        message: "x",
      },
      { index: 7, field: "order", code: "duplicate_order", message: "y" },
    ]);
    expect(issues.get("row0")?.[0]).toMatch(/Служба сценария не совпадает/);
    expect(issues.size).toBe(1);
  });
});
