import { describe, expect, it } from "vitest";
import {
  conflictKind,
  constructorFromForm,
  copyForm,
  emptyForm,
  expectedActions,
  formFromPreview,
  formFromScenario,
  hasErrors,
  keywordList,
  outcomeOf,
  OUTCOME_FLOWS,
  scenarioFromForm,
  sectionForServerError,
  serviceForType,
  validateForm,
  type Scenario,
} from "./studioModel";

// Реальный сценарий из seed (GET /scenarios на стенде database).
const seed = {
  id: "00000000-0000-4000-8000-000000000100",
  version: 1,
  level: 1,
  weight: 1,
  incident_type_code: "2020000",
  target_service_id: "102",
  card: {
    tags: ["ДТП пострадавшие"],
    number: "10000001",
    address: {
      city: "Москва",
      house: "1",
      okrug: "Северный",
      street: "Дубнинская улица",
      building: "",
      district: "Учебный",
      apartment: "",
    },
    victims: true,
    emergency: false,
    phone_aon: "+79000000001",
    caller_name: "Учебный заявитель",
    description:
      "Учебное происшествие: ДТП с пострадавшими. Москва, Дубнинская улица, дом 1.",
    phone_scene: "",
    service_ids: ["102"],
    blocked_people: false,
    incident_class: "ДТП с пострадавшими",
    phone_provided: "",
    ambulance_refused: false,
    incident_type_code: "2020000",
  },
  reference: {
    expected_call: {
      before_s: 180,
      required: true,
      phone_ext: "102",
      service_id: "102",
    },
    expected_flow: ["received", "accepted", "responding", "completed"],
    required_fields: ["service_number", "comment"],
    expected_address: {
      city: "Москва",
      house: "1",
      okrug: "Северный",
      street: "Дубнинская улица",
      building: "",
      district: "Учебный",
      apartment: "",
    },
    expected_comment:
      "В службу 102 передана информация: ДТП с пострадавшими. Москва, Дубнинская улица, дом 1. Направлен экипаж.",
    expected_service_ids: ["102"],
  },
  complications: [],
  origin: "template",
  status: "approved",
  teacher_comment: "Синтетическая фикстура для разработки.",
} as unknown as Scenario;

const services = [{ id: "102", phone_ext: "102" }];
const name = (id: string) => (id ? `Служба ${id}` : "");

// Переходы карточки ДДС — как в packages/evalcore/evalcore/validation.py.
const TRANSITIONS: Record<string, string[]> = {
  received: ["accepted", "rejected"],
  accepted: ["responding", "refused"],
  responding: ["completed", "refused"],
  rejected: ["redirected"],
};

describe("студия сценариев: форма ↔ Scenario", () => {
  it("проводит сценарий из seed через форму без потерь", () => {
    const back = scenarioFromForm(formFromScenario(seed), services);
    expect(back).toEqual(seed);
  });

  it("ключевые слова комментария: список без пустых и повторов, в эталон — только непустой", () => {
    expect(
      keywordList(" утечка /  запах газа, , эвакуация, эвакуация "),
    ).toEqual(["утечка / запах газа", "эвакуация"]);
    const form = { ...formFromScenario(seed), commentKeywords: "эвакуация" };
    const saved = scenarioFromForm(form, services).reference as {
      comment_keywords?: string[];
    };
    expect(saved.comment_keywords).toEqual(["эвакуация"]);
    expect(
      formFromScenario(scenarioFromForm(form, services)).commentKeywords,
    ).toBe("эвакуация");
    expect(
      "comment_keywords" in
        scenarioFromForm(formFromScenario(seed), services).reference,
    ).toBe(false);
  });

  it("каждый исход эталона проходит проверку переходов evalcore", () => {
    for (const flow of Object.values(OUTCOME_FLOWS)) {
      expect(flow[0]).toBe("received");
      expect(["completed", "refused", "rejected", "redirected"]).toContain(
        flow[flow.length - 1],
      );
      expect(
        flow.some((state) =>
          ["accepted", "rejected", "redirected"].includes(state),
        ),
      ).toBe(true);
      for (let i = 1; i < flow.length; i += 1)
        expect(TRANSITIONS[flow[i - 1]]).toContain(flow[i]);
    }
  });

  it("узнаёт исход по последовательности, в том числе с «added»", () => {
    expect(outcomeOf(["added", "received", "rejected", "redirected"])).toBe(
      "redirect",
    );
    expect(outcomeOf(["received", "accepted", "refused"])).toBe(
      "accept_refuse",
    );
  });

  it("копия — новый черновик первой версии", () => {
    const copy = copyForm(formFromScenario(seed), "new-id");
    expect(copy).toMatchObject({ id: "new-id", version: 1, status: "draft" });
    expect(copy.incidentClass).toBe("ДТП с пострадавшими");
  });

  it("подставляет службу MVP только по закреплённому соответствию", () => {
    expect(serviceForType({ main_service_code: "MCHS" })).toBe("101");
    expect(serviceForType({ main_service_code: "Police" })).toBe("102");
    expect(serviceForType({ main_service_code: "METRO" })).toBe("");
  });
});

describe("студия сценариев: проверки у полей", () => {
  it("черновик можно сохранить неполным, утвердить — нет", () => {
    const form = {
      ...emptyForm("id", "12345678"),
      incidentTypeCode: "2020000",
      targetServiceId: "102",
    };
    expect(hasErrors(validateForm(form, "draft"))).toBe(false);
    const approve = validateForm(form, "approve");
    expect(approve.card).toContain(
      "Опишите происшествие: его читает обучаемый.",
    );
    expect(approve.address?.length).toBe(1);
    expect(approve.call).toContain(
      "Для обязательного звонка укажите службу-получателя.",
    );
  });

  it("ловит номер и телефоны вне формата контракта", () => {
    const form = {
      ...emptyForm("id", "123"),
      phoneAon: "89001234567",
    };
    const errors = validateForm(form, "draft");
    expect(errors.card).toContain("Номер карточки — ровно 8 цифр.");
    expect(errors.card?.some((m) => m.includes("АОН"))).toBe(true);
    expect(errors.incident?.length).toBe(2);
  });

  it("перенаправление без получателя не утверждается", () => {
    const form = { ...formFromScenario(seed), outcome: "redirect" as const };
    expect(validateForm(form, "approve").reference).toBeUndefined();
    form.expectedServiceIds = [];
    expect(validateForm(form, "approve").reference).toEqual([
      "Для перенаправления укажите службу-получателя.",
    ]);
  });

  it("раскладывает ошибки сервера по разделам и узнаёт 409", () => {
    expect(
      sectionForServerError(
        "Эталон должен содержать решение о принятии, отказе или перенаправлении.",
      ),
    ).toBe("reference");
    expect(
      sectionForServerError(
        "Для обязательного звонка укажите службу-получателя.",
      ),
    ).toBe("call");
    expect(
      sectionForServerError("Неизвестный тип происшествия или служба."),
    ).toBe("incident");
    expect(sectionForServerError("Что-то иное")).toBe("general");
    expect(
      conflictKind("Назначенный сценарий нельзя изменить. Создайте копию."),
    ).toBe("assigned");
    expect(
      conflictKind("Сценарий уже изменён. Загрузите актуальную версию."),
    ).toBe("stale");
  });
});

describe("студия сценариев: эталон словами", () => {
  it("перечисляет ожидаемые действия по порядку работы", () => {
    const steps = expectedActions(formFromScenario(seed), name);
    expect(steps[0]).toBe("Принять карточку.");
    expect(steps).toContain(
      "Позвонить в Служба 102 не позднее 3 мин после появления карточки.",
    );
    expect(steps).toContain("Поставить «Начало реагирования».");
    expect(steps).toContain("Заполнить: номер в службе, комментарий.");
    expect(steps[steps.length - 1]).toBe("Закрыть: «Работы завершены».");
  });

  it("помечает исправленный адрес при осложнении «неверный адрес»", () => {
    const form = {
      ...formFromScenario(seed),
      addressAsCard: false,
      expectedAddress: {
        ...formFromScenario(seed).address,
        street: "Дубининская улица",
      },
    };
    expect(
      expectedActions(form, name).some((step) =>
        step.includes("Дубининская улица, д. 1 (исправленный"),
      ),
    ).toBe(true);
  });
});

describe("конструктор C-05", () => {
  it("запрос берёт выбор преподавателя и seed", () => {
    const form = {
      ...formFromScenario(seed),
      complications: ["no_phone" as const],
    };
    const request = constructorFromForm(form, 42);
    expect(request).toMatchObject({
      incident_type_code: "2020000",
      target_service_id: "102",
      complications: ["no_phone"],
      level: 1,
      weight: 1,
      seed: 42,
    });
    expect(request.address.city).toBe("Москва");
  });

  it("собранный сервером сценарий не меняет номер, версию и статус формы", () => {
    const form = {
      ...emptyForm("my-id", "55555555"),
      version: 3,
      teacherComment: "мой комментарий",
    };
    const built = {
      ...seed,
      id: "server-id",
      card: { ...seed.card, number: "10000001", description: "От сервера." },
    } as Scenario;
    const next = formFromPreview(form, { scenario: built });
    expect(next.id).toBe("my-id");
    expect(next.number).toBe("55555555");
    expect(next.version).toBe(3);
    expect(next.status).toBe("draft");
    expect(next.teacherComment).toBe("мой комментарий");
    expect(next.description).toBe("От сервера.");
    expect(next.incidentTypeCode).toBe("2020000");
  });
});
