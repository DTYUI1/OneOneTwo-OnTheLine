import { describe, expect, it } from "vitest";
import v2 from "../../../../contracts/examples/timing-v2.json";
import v3 from "../../../../contracts/examples/timing-v3.json";
import type { TimingFixture } from "./contracts";
import { calculateTiming } from "./timing";

const cases = [...v2, ...v3] as TimingFixture[];

describe("calculateTiming: общие примеры I-TIME v1/v2/v3", () => {
  it.each(cases)("$name", ({ input, expected }) => {
    expect(calculateTiming(input)).toEqual(expected);
  });

  it("один вход даёт один результат и не меняет вход", () => {
    const input = structuredClone(cases[0].input);
    const before = JSON.stringify(input);
    expect(calculateTiming(input)).toEqual(calculateTiming(input));
    expect(JSON.stringify(input)).toBe(before);
  });
});
