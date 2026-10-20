import { describe, expect, it } from "vitest";
import { litSegments, METER_SEGMENTS, peakZone, segmentZone } from "./meter";

describe("шкала громкости записи", () => {
  it("16 делений: пять тихих, семь в норме, четыре громких", () => {
    const zones = Array.from({ length: METER_SEGMENTS }, (_, index) =>
      segmentZone(index),
    );
    expect(zones.filter((zone) => zone === "quiet")).toHaveLength(5);
    expect(zones.filter((zone) => zone === "ok")).toHaveLength(7);
    expect(zones.filter((zone) => zone === "loud")).toHaveLength(4);
    expect(zones.indexOf("ok")).toBe(5);
    expect(zones.indexOf("loud")).toBe(12);
  });

  it("уровень вне 0…1 не выходит за шкалу", () => {
    expect(litSegments(-1)).toBe(0);
    expect(litSegments(2)).toBe(METER_SEGMENTS);
    expect(litSegments(0.5)).toBe(8);
  });

  it("пик фразы: верхнее горевшее деление (GP-24: «записано в норме»)", () => {
    expect(peakZone(0)).toBe("quiet");
    expect(peakZone(5 / 16)).toBe("quiet");
    expect(peakZone(6 / 16)).toBe("ok");
    expect(peakZone(12 / 16)).toBe("ok");
    expect(peakZone(13 / 16)).toBe("loud");
    expect(peakZone(1)).toBe("loud");
  });
});
