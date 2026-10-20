import { describe, expect, it } from "vitest";
import { EMPTY_ADDRESS } from "./model";
import { cardInput } from "./save";

describe("тело запроса «сохранить»", () => {
  it("собирает адрес и теги в форму /api/operator/save", () => {
    const address = {
      ...EMPTY_ADDRESS,
      subject: "Москва",
      okrug: "САО",
      district: "Западное Дегунино",
      street: "Дубнинская улица",
      house: "12",
      korpus: "",
      apartment: "47",
      object: "Жилой дом",
      structure: "1",
      entrance: "2",
      floor: "5",
      code: "58",
      descriptive: "Напротив школы",
    };
    const body = cardInput({
      incidentTypeCode: "1050102",
      tags: new Set(["victims"]),
      services: ["101", "102", "103", "MOSLIFT"],
      address,
      description: "Задымление в квартире.",
      callerName: "Соснина Ольга Викторовна",
      callerStatus: "очевидец",
      phoneProvided: "",
      phoneScene: "",
      offSite: false,
    });
    expect(body).toEqual({
      incident_type_code: "1050102",
      tags: ["victims"],
      services: ["101", "102", "103", "MOSLIFT"],
      address: {
        city: "Москва",
        okrug: "САО",
        district: "Западное Дегунино",
        street: "Дубнинская улица",
        house: "12",
        building: "",
        apartment: "47",
        object: "Жилой дом",
        structure: "1",
        entrance: "2",
        floor: "5",
        code: "58",
        descriptive: "Напротив школы",
      },
      description: "Задымление в квартире.",
      caller_name: "Соснина Ольга Викторовна",
      caller_status: "очевидец",
      phone_provided: "",
      phone_scene: "",
      off_site: false,
    });
  });

  it("без типа происшествия отправляет null", () => {
    const body = cardInput({
      incidentTypeCode: null,
      tags: new Set(),
      services: [],
      address: EMPTY_ADDRESS,
      description: "",
      callerName: "",
      callerStatus: "",
      phoneProvided: "",
      phoneScene: "",
      offSite: false,
    });
    expect(body.incident_type_code).toBeNull();
    expect(body.caller_status).toBe("");
    for (const field of [
      "object",
      "structure",
      "entrance",
      "floor",
      "code",
      "descriptive",
    ] as const)
      expect(body.address[field]).toBe("");
  });
});
