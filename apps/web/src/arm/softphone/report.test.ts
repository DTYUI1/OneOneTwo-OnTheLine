import { describe, expect, it } from "vitest";
import {
  CLARIFY,
  REPORT_MEMO,
  REPORT_PARTS,
  partsOf,
  reportFacts,
  pickedParts,
  reportSteps,
  type ReportFacts,
  type ReportPart,
  type ReportPick,
  type ReportStep,
  choiceOf,
  clarifyFor,
  heardSoFar,
  nextAsk,
  pickedGap,
  requiredParts,
} from "./report";
import { MAX_OPTIONS } from "./parts";

const facts: ReportFacts = {
  trainee: "Обучаемый 01",
  service: "Служба 102",
  number: "10000001",
  incident: "ДТП с пострадавшими",
  address: {
    city: "Москва",
    okrug: "Северный",
    district: "Учебный",
    street: "Дубнинская улица",
    house: "1",
    building: "2",
    apartment: "",
  },
  victims: true,
  blockedPeople: false,
  state: "accepted",
  brigades: ["Учебная бригада 1 службы 102"],
};

function steps(input: ReportFacts = facts, said: ReportPart[] = []) {
  return reportSteps(input, "call-1", said);
}

function right(step: ReportStep): string {
  return step.options.find((item) => item.correct)!.text;
}

function wrong(step: ReportStep): string[] {
  return step.options
    .filter((item) => !item.correct)
    .map((item) => item.text)
    .sort();
}

describe("Доклад службе по частям (GP-06)", () => {
  it.each([
    [["Бригада 201"], "Есть пострадавшие, направлена бригада 201"],
    [
      ["Бригада 201", "Бригада 202"],
      "Есть пострадавшие, направлены: бригада 201, бригада 202",
    ],
    [["Расчёт Северный"], "Есть пострадавшие, направлена Расчёт Северный"],
  ])("подставляет имена бригад в середину фразы: %s", (brigades, text) => {
    const change = steps({ ...facts, brigades }).find(
      (step) => step.key === "change",
    )!;
    expect(right(change)).toBe(text);
  });

  it("шаги по памятке: кто вы, адрес, что случилось, карточка, что изменилось", () => {
    expect(steps().map((step) => step.label)).toEqual([
      "Кто вы",
      "Адрес",
      "Что случилось",
      "Карточка",
      "Что изменилось",
    ]);
  });

  it("на шаге до трёх коротких вариантов, верный ровно один", () => {
    for (const input of [
      facts,
      { ...facts, brigades: [] },
      { ...facts, victims: false, blockedPeople: true },
      { ...facts, trainee: "", service: "" },
      {
        ...facts,
        incident:
          "Столкновение двух легковых автомобилей на перекрёстке, есть пострадавшие, перекрыто движение",
      },
    ])
      for (const step of steps(input)) {
        expect(step.options.length).toBeGreaterThan(1);
        expect(step.options.length).toBeLessThanOrEqual(MAX_OPTIONS);
        expect(step.options.filter((item) => item.correct)).toHaveLength(1);
        for (const item of step.options) {
          expect(item.text.length).toBeLessThan(60);
          expect(item.text).not.toContain("!");
        }
      }
  });

  it("верные части — из карточки", () => {
    expect(steps().map(right)).toEqual([
      "Диспетчер Обучаемый 01, Служба 102",
      "Дубнинская улица, 1, корпус 2",
      "ДТП с пострадавшими",
      "Работаем по карточке 10000001",
      "Есть пострадавшие, направлена Учебная бригада 1 службы 102",
    ]);
  });

  it("ошибки — как у живого человека: буква в улице, цифра в доме, не тот номер", () => {
    const [who, address, , card, change] = steps();
    expect(wrong(who!)).toEqual(["Звоню по вызову", "Служба 102"]);
    expect(wrong(address!)).toEqual([
      "Бубнинская улица, 14, корпус 2",
      "Дупнинская улица, 1, корпус 2",
    ]);
    expect(wrong(card!)).toEqual([
      "Звоню по новому вызову",
      "Работаем по карточке 10000002",
    ]);
    expect(wrong(change!)).toContain("Остальное — в карточке");
  });

  it("прозвучавшие части не спрашиваются снова", () => {
    expect(steps(facts, ["who", "card"]).map((step) => step.key)).toEqual([
      "address",
      "what",
      "change",
    ]);
    expect(steps(facts, ["who", "address", "card", "change"])).toEqual([]);
  });

  it("неверная часть не засчитана: служба её переспросит", () => {
    const all: ReportPick[] = [
      { key: "who", correct: true },
      { key: "address", correct: true },
      { key: "what", correct: true },
      { key: "card", correct: true },
      { key: "change", correct: true },
    ];
    expect(pickedParts(all)).toEqual(["who", "address", "card", "change"]);
    // «Бубнинская, 124» — адрес не прозвучал, хотя повод верный.
    const parts = pickedParts(
      all.map((pick) =>
        pick.key === "address" ? { ...pick, correct: false } : pick,
      ),
    );
    expect(parts).toEqual(["who", "card", "change"]);
    expect(choiceOf(parts)).toBe("no_address");
    expect(clarifyFor(parts)).toBe(CLARIFY.no_address);
    expect(
      pickedParts(
        all.map((pick) =>
          pick.key === "what" ? { ...pick, correct: false } : pick,
        ),
      ),
    ).not.toContain("address");
  });

  it("без направленных бригад — о решении по силам", () => {
    expect(right(steps({ ...facts, brigades: [] })[4]!)).toBe(
      "Есть пострадавшие, силы назначаются",
    );
    expect(
      right(steps({ ...facts, brigades: [], state: "received" })[4]!),
    ).toBe("Есть пострадавшие, решение по силам принимается");
    expect(
      right(steps({ ...facts, victims: false, blockedPeople: true })[4]!),
    ).toContain("Пострадавших нет, есть заблокированные");
  });

  it("кто вы без ФИО и службы — хотя бы должность", () => {
    expect(right(steps({ ...facts, trainee: "", service: "" })[0]!)).toBe(
      "Диспетчер",
    );
  });

  it("порядок вариантов постоянен в звонке и зависит от звонка", () => {
    const order = (seed: string) =>
      reportSteps(facts, seed)
        .map((step) => step.options.map((item) => item.text).join())
        .join("|");
    expect(order("call-1")).toBe(order("call-1"));
    expect(
      new Set(["a", "b", "c", "d", "e", "f"].map(order)).size,
    ).toBeGreaterThan(1);
  });

  it("служба переспрашивает ровно недостающую часть — фразами банка дежурного", () => {
    expect(CLARIFY.no_who).toBe("Кто докладывает? Представьтесь, пожалуйста.");
    expect(CLARIFY.no_address).toBe("Адрес повторите, пожалуйста.");
    expect(CLARIFY.no_card).toBe("Продиктуйте номер карточки.");
    expect(CLARIFY.no_change).toBe("Кратко доложите обстановку на месте.");
  });

  it("служба переспрашивает одним вопросом: первую недостающую часть памятки", () => {
    expect(clarifyFor(["who", "address", "card", "change"])).toBeNull();
    expect(clarifyFor(["who", "address", "change"])).toBe(CLARIFY.no_card);
    // Ничего не прозвучало — только «кто вы», остальное спросит следующим вопросом.
    expect(clarifyFor([])).toBe(CLARIFY.no_who);
    expect(clarifyFor(["address", "change"])).toBe(CLARIFY.no_who);
    expect(clarifyFor(["who"])).toBe(CLARIFY.no_address);
  });

  it("доклад за звонок: услышанное остаётся ✓, служба спрашивает следующее по одному", () => {
    // Стенд 17.10, звонок в 101: «Варшавское шоссе 87 горит автомобиль» → «Обучаемый 01,
    // служба 102» → «по карточке 70005313».
    let said: ReportPart[] = heardSoFar([], ["address", "change"]);
    expect(choiceOf(said)).toBe("no_who");
    expect(nextAsk(said)).toBe("who");
    said = heardSoFar(said, ["who"]);
    expect(said).toEqual(["who", "address", "change"]);
    expect(nextAsk(said)).toBe("card");
    // Фраза без новых частей не снимает прежние ✓.
    said = heardSoFar(said, []);
    expect(said).toEqual(["who", "address", "change"]);
    said = heardSoFar(said, ["card"]);
    expect(choiceOf(said)).toBe("full");
    expect(nextAsk(said)).toBeNull();
  });

  it("у адреса и повода спрашивают то, чего не хватило", () => {
    expect(nextAsk(["who"])).toBe("place");
    expect(nextAsk(["who"], "place")).toBe("place");
    expect(nextAsk(["who"], "reason")).toBe("reason");
    expect(clarifyFor(["who", "card"], "reason")).toBe(
      "Уточните, что именно произошло.",
    );
    expect(nextAsk(["who", "address"], "reason")).toBe("card");
    expect(nextAsk(["who", "address", "card"])).toBe("change");
  });

  it("по частям: неверный адрес — переспрос адреса, неверный повод — повода", () => {
    const ok = { correct: true };
    expect(
      pickedGap([
        { key: "address", ...ok },
        { key: "what", ...ok },
      ]),
    ).toBeNull();
    expect(
      pickedGap([
        { key: "address", correct: false },
        { key: "what", ...ok },
      ]),
    ).toBe("place");
    expect(
      pickedGap([
        { key: "address", ...ok },
        { key: "what", correct: false },
      ]),
    ).toBe("reason");
    expect(pickedGap([{ key: "who", ...ok }])).toBe("place");
  });

  it("адрес прозвучал, не хватило повода — круг по частям без шага «Адрес»", () => {
    // Стенд 18.10, звонок в 103: адрес ✓, повод ✗ → «Уточните, что случилось с человеком»,
    // а следующий круг начинался с «Адрес».
    const labels = (gap: "place" | "reason" | null) =>
      reportSteps(facts, "call-1", ["who"], undefined, gap).map(
        (step) => step.label,
      );
    expect(labels("reason")).toEqual([
      "Что случилось",
      "Карточка",
      "Что изменилось",
    ]);
    expect(labels("place")).toEqual([
      "Адрес",
      "Что случилось",
      "Карточка",
      "Что изменилось",
    ]);
    expect(labels(null)).toEqual(labels("place"));
    // Часть «адрес и повод» прозвучала — её шагов нет при любом gap.
    expect(
      reportSteps(facts, "call-1", ["who", "address"], undefined, "reason").map(
        (step) => step.label,
      ),
    ).toEqual(["Карточка", "Что изменилось"]);
  });

  it("круг без шага «Адрес»: неверный повод — переспрос повода, верный — часть прозвучала", () => {
    const wrong = [{ key: "what" as const, correct: false }];
    const right = [{ key: "what" as const, correct: true }];
    expect(pickedGap(wrong, true)).toBe("reason");
    expect(pickedGap(right, true)).toBeNull();
    expect(pickedParts(right)).toEqual(["address"]);
    // Адрес не звучал — круг без шага «Адрес» переспрашивает адрес, как раньше.
    expect(pickedGap(right)).toBe("place");
    expect(pickedGap([{ key: "address", correct: false }], true)).toBe("place");
  });

  it("части по виду доклада: полный — все четыре, неполный — без своей", () => {
    const all = REPORT_PARTS.map(({ part }) => part);
    expect(partsOf("full")).toEqual(all);
    expect(partsOf("extra")).toEqual(all);
    expect(partsOf("no_card")).toEqual(["who", "address", "change"]);
    expect(partsOf("no_who")).toEqual(["address", "card", "change"]);
  });

  it("памятка — дословно, с. 32", () => {
    expect(REPORT_MEMO).toContain(
      "представиться (ФИО, должность, служба), назвать адрес места происшествия и повод для вызова",
    );
    expect(REPORT_MEMO).toContain("(можно сообщить номер)");
  });

  it("сведения доклада — из карточки", () => {
    const card = {
      state: "received" as const,
      source: {
        number: "10000002",
        incident_class: "",
        description: "Пожар в подъезде",
        address: facts.address,
        victims: false,
        blocked_people: true,
      },
    } as Parameters<typeof reportFacts>[0];
    expect(
      reportFacts(card, [], {
        trainee: " Обучаемый 02 ",
        service: "Служба 101",
      }),
    ).toMatchObject({
      trainee: "Обучаемый 02",
      service: "Служба 101",
      number: "10000002",
      incident: "Пожар в подъезде",
      blockedPeople: true,
      state: "received",
    });
  });
});

describe("вид доклада по частям", () => {
  it("первая недостающая часть по порядку памятки", () => {
    expect(choiceOf(["address", "card", "change"])).toBe("no_who");
    expect(choiceOf(["who", "card"])).toBe("no_address");
    expect(choiceOf(["who", "address", "change"])).toBe("no_card");
    expect(choiceOf(["who", "address", "card", "change"])).toBe("full");
  });

  it("сходится с partsOf", () => {
    for (const choice of [
      "full",
      "no_who",
      "no_address",
      "no_card",
      "no_change",
    ] as const)
      expect(choiceOf(partsOf(choice))).toBe(choice);
  });
});

describe("карточка — только в звонке в 112 (памятка ДДС, с. 32)", () => {
  const noCard = requiredParts("401");

  it("в 112 обязательны четыре части, в остальных звонках — без карточки", () => {
    expect(requiredParts("112")).toEqual(["who", "address", "card", "change"]);
    expect(noCard).toEqual(["who", "address", "change"]);
    expect(requiredParts("101")).toEqual(noCard);
    expect(requiredParts(null)).toEqual(["who", "address", "card", "change"]);
  });

  it("доклад без карточки полный, карточку не переспрашивают и шага нет", () => {
    expect(choiceOf(["who", "address", "change"], noCard)).toBe("full");
    expect(clarifyFor(["who", "address", "change"], null, noCard)).toBeNull();
    expect(nextAsk(["who", "address"], null, noCard)).toBe("change");
    expect(
      reportSteps(facts, "call-1", [], noCard).map((step) => step.label),
    ).toEqual(["Кто вы", "Адрес", "Что случилось", "Что изменилось"]);
  });
});
