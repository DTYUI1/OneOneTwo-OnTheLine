import { describe, expect, it } from "vitest";
import {
  groupByService,
  trainsText,
  type PracticeScenario,
} from "./catalogModel";

function scenario(id: string, service_id: string, level = 1): PracticeScenario {
  return {
    id,
    version: 1,
    title: `Сценарий ${id}`,
    service_id,
    service_name: `Служба ${service_id}`,
    level,
    description: "Описание",
    trains: ["clarify"],
  };
}

describe("каталог сценариев", () => {
  it("своя служба первой, остальные — в порядке сервера", () => {
    const groups = groupByService(
      [
        scenario("a", "101"),
        scenario("b", "102"),
        scenario("c", "102", 2),
        scenario("d", "103"),
      ],
      "102",
    );
    expect(groups.map((group) => group.serviceId)).toEqual([
      "102",
      "101",
      "103",
    ]);
    expect(groups[0].own).toBe(true);
    expect(groups[0].items.map((item) => item.id)).toEqual(["b", "c"]);
    expect(groups.slice(1).every((group) => !group.own)).toBe(true);
  });

  it("без своей службы — порядок сервера", () => {
    const groups = groupByService(
      [scenario("a", "101"), scenario("b", "104")],
      null,
    );
    expect(groups.map((group) => group.serviceId)).toEqual(["101", "104"]);
  });

  it("чему учит — простыми словами, неизвестное пропускается", () => {
    expect(
      trainsText([
        "readback_error",
        "clarify",
        "request_service",
        "silence",
        "alarm",
        "future_kind",
      ]),
    ).toBe(
      "ловушка повтора адреса, уточнение, просьба вызвать службу, молчание бригады, тревога",
    );
    expect(trainsText([])).toBe("");
  });
});
