import { describe, expect, it } from "vitest";
import { newPack, readiness, summarizePack, type Pack } from "./packModel";
import type { Scenario } from "./studioModel";

const pack = (id: string) => ({ id }) as Pack;

const good = (status: Scenario["status"] = "draft") =>
  ({
    id: "g-" + status,
    version: 1,
    level: 1,
    weight: 1,
    status,
    origin: "template",
    incident_type_code: "2020000",
    target_service_id: "102",
    teacher_comment: "",
    complications: [],
    card: {
      number: "10000001",
      incident_type_code: "2020000",
      incident_class: "ДТП",
      caller_name: "",
      phone_aon: "",
      phone_provided: "",
      phone_scene: "",
      address: {
        city: "Москва",
        okrug: "",
        district: "",
        street: "Тверская",
        house: "1",
        building: "",
        apartment: "",
      },
      description: "ДТП",
      tags: [],
      victims: false,
      ambulance_refused: false,
      blocked_people: false,
      emergency: false,
      service_ids: ["102"],
    },
    reference: {
      expected_flow: ["received", "accepted", "responding", "completed"],
      expected_call: { required: true, service_id: "102", before_s: 180 },
    },
  }) as unknown as Scenario;

describe("пакеты сценариев", () => {
  it("находит пакет, которого не было до генерации", () => {
    expect(newPack([pack("a")], [pack("a"), pack("b")])?.id).toBe("b");
    expect(newPack([pack("a")], [pack("a")])).toBeNull();
  });

  it("черновик с полным эталоном готов, без адреса — нет, с причиной", () => {
    expect(readiness(good())).toEqual({ ready: true, reasons: [] });
    const noAddress = good();
    noAddress.card.address.street = "";
    const verdict = readiness(noAddress);
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons[0]).toMatch(/улицу и дом/);
    expect(readiness(good("approved")).ready).toBe(false);
  });

  it("считает пакет: утверждено, готово, заблокировано", () => {
    const broken = good();
    (broken.card as { description: string }).description = "";
    expect(summarizePack([good(), good("approved"), broken])).toEqual({
      total: 3,
      approved: 1,
      ready: 1,
      blocked: 1,
    });
  });
});
