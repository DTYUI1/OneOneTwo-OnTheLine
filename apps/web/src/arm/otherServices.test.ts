import { describe, expect, it } from "vitest";
import { otherServiceStatus, otherServiceSteps } from "./otherServices";

const appeared = Date.parse("2026-10-17T09:00:00Z");

describe("чужие службы на полосе служб (TC-07)", () => {
  it("получают, принимают и чаще всего начинают реагирование по расписанию", () => {
    let responding = 0;
    for (let index = 0; index < 60; index += 1) {
      const steps = otherServiceSteps(`card-${index}`, "103", appeared);
      expect(steps.map((step) => step.state).slice(0, 3)).toEqual([
        "added",
        "received",
        "accepted",
      ]);
      const [, received, accepted, next] = steps;
      expect(received.atMs - appeared).toBeGreaterThanOrEqual(8_000);
      expect(received.atMs - appeared).toBeLessThanOrEqual(19_000);
      expect(accepted.atMs - received.atMs).toBeGreaterThanOrEqual(10_000);
      expect(accepted.atMs - received.atMs).toBeLessThanOrEqual(34_000);
      if (next) {
        responding += 1;
        expect(next.state).toBe("responding");
        expect(next.atMs - accepted.atMs).toBeGreaterThanOrEqual(30_000);
        expect(next.atMs - accepted.atMs).toBeLessThanOrEqual(89_000);
      }
    }
    // Две службы из трёх — с бригадой, третья остаётся «Принята».
    expect(responding).toBeGreaterThan(25);
    expect(responding).toBeLessThan(55);
  });

  it("статус на момент — последний наступивший шаг, у всех экранов один", () => {
    const at = new Date(appeared).toISOString();
    expect(otherServiceStatus("c", "104", at, appeared).state).toBe("added");
    expect(otherServiceStatus("c", "104", at, appeared - 5_000).state).toBe(
      "added",
    );
    const later = otherServiceStatus("c", "104", at, appeared + 60_000);
    expect(["accepted", "responding"]).toContain(later.state);
    expect(otherServiceStatus("c", "104", at, appeared + 60_000)).toEqual(
      later,
    );
    expect(otherServiceSteps("c", "104", appeared)).not.toEqual(
      otherServiceSteps("c", "102", appeared),
    );
  });
});
