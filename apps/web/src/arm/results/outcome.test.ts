import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CardOutcome,
  compactOutcomes,
  outcomeFacts,
  pickOutcome,
  practiceCard,
  type PracticeIncident,
} from "./outcome";

const repo = join(process.cwd(), "../..");
const practiceDir = join(repo, "data/practice");
const incidents = readdirSync(practiceDir)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map(
    (name) =>
      JSON.parse(
        readFileSync(join(practiceDir, name), "utf8"),
      ) as PracticeIncident & { services: Record<string, unknown> },
  );
const expected = compactOutcomes(incidents);
const target = join(process.cwd(), "src/arm/results/outcomes.json");

if (process.env.UPDATE_PRACTICE_OUTCOMES === "1")
  writeFileSync(target, JSON.stringify(expected, null, 2) + "\n");

describe("исходы сценариев тренировки", () => {
  it("копия совпадает с data/practice", () => {
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(expected);
  });

  it("исход есть у каждого сценария, на обоих уровнях", () => {
    for (const incident of incidents) {
      expect(incident.outcome, incident.key).toBeDefined();
      for (const level of [1, 2]) {
        const number = `70005${incident.order}0${level}`;
        const outcome = pickOutcome({ number, late: false, statusOk: true });
        expect(outcome?.paragraphs.length, `${incident.key} ${level}`).toBe(1);
      }
    }
  });
});

describe("выбор исхода", () => {
  // Задымление: order 1; служба 101 — первая (индекс 0).
  const full = "70005101";
  const complication = "70005102";
  const smoke = incidents.find((item) => item.key === "smoke-apartment")!;

  it("номер тренировки: происшествие и уровень", () => {
    expect(practiceCard(full)).toEqual({ order: "1", level: 1 });
    expect(practiceCard("70005232")).toEqual({ order: "2", level: 2 });
    expect(practiceCard("70004231")).toBeNull();
  });

  it("вовремя и верно — только что стало с людьми, и почему это важно", () => {
    const outcome = pickOutcome({ number: full, late: false, statusOk: true });
    expect(outcome?.paragraphs).toEqual([smoke.outcome!.people]);
    expect(outcome?.why).toContain("UL FSRI");
  });

  it("опоздали — исход говорит, чем обернулась задержка", () => {
    const outcome = pickOutcome({ number: full, late: true, statusOk: true });
    expect(outcome?.paragraphs).toEqual([
      smoke.outcome!.people,
      smoke.outcome!.late,
    ]);
  });

  it("статусы не по докладам — об этом отдельной строкой", () => {
    const outcome = pickOutcome({ number: full, late: false, statusOk: false });
    expect(outcome?.paragraphs.at(-1)).toMatch(/не по докладам/);
  });

  it("осложнение — что было на самом деле; не тот итог — про «Отказ»", () => {
    const ok = pickOutcome({
      number: complication,
      late: false,
      statusOk: true,
    });
    expect(ok?.paragraphs).toEqual([smoke.outcome!.complication]);
    expect(ok?.why).toBeNull();
    const wrong = pickOutcome({
      number: complication,
      late: true,
      statusOk: false,
    });
    expect(wrong?.paragraphs).toHaveLength(3);
    expect(wrong?.paragraphs.at(-1)).toMatch(/Отказом от выполнения работ/);
  });

  it("не тренировка или нет исхода — блока нет", () => {
    expect(
      pickOutcome({ number: "70004231", late: false, statusOk: true }),
    ).toBeNull();
    expect(
      pickOutcome({ number: full, late: false, statusOk: true }, {}),
    ).toBeNull();
  });

  it("факты из оценки: реакция и ход статусов", () => {
    expect(
      outcomeFacts([
        { key: "reaction_time", score: 0.4 },
        { key: "status_flow", score: 1 },
      ]),
    ).toEqual({ late: true, statusOk: true });
    expect(
      outcomeFacts([
        { key: "reaction_time", score: 1 },
        { key: "status_flow", score: 0.75 },
      ]),
    ).toEqual({ late: false, statusOk: false });
    // Критерий не применим к попытке — не наказываем исходом.
    expect(outcomeFacts([])).toEqual({ late: false, statusOk: true });
  });
});

describe("исход сценария из файла (GP-27)", () => {
  const scenario = {
    people: "Расчёт нашёл очаг: горела проводка за шкафом.",
    late: "Карточку приняли позже норматива.",
    why: "Источник: UL FSRI.",
    status: "Ход статусов отличается от доклада экипажа.",
  };
  // Карточка 101 набора на финал: тот же номер, что у тренировки «Задымление».
  const number = "70005101";

  it("берётся исход сценария, а не копия по номеру", () => {
    const outcome = pickOutcome({
      number,
      late: false,
      statusOk: true,
      scenario,
    });
    expect(outcome?.paragraphs).toEqual([scenario.people]);
    expect(outcome?.paragraphs.join(" ")).not.toMatch(/кухн/);
    expect(outcome?.why).toBe(scenario.why);
  });

  it("поздняя «Принята» добавляет абзац сценария, статусы — его строку или общую", () => {
    const late = pickOutcome({ number, late: true, statusOk: true, scenario });
    expect(late?.paragraphs).toEqual([scenario.people, scenario.late]);
    const wrong = pickOutcome({
      number,
      late: false,
      statusOk: false,
      scenario,
    });
    expect(wrong?.paragraphs).toEqual([scenario.people, scenario.status]);
    const plain = pickOutcome({
      number,
      late: false,
      statusOk: false,
      scenario: { people: scenario.people, late: scenario.late },
    });
    expect(plain?.paragraphs.at(-1)).toMatch(/не по докладам/);
    expect(plain?.why).toBeNull();
  });

  it("номер не тренировки (70008…) — исход всё равно есть", () => {
    const outcome = pickOutcome({
      number: "70008301",
      late: true,
      statusOk: true,
      scenario,
    });
    expect(outcome?.paragraphs).toEqual([scenario.people, scenario.late]);
  });

  it("старый сценарий без блока — исход по номеру, как раньше", () => {
    const old = pickOutcome({ number, late: false, statusOk: true });
    expect(old).toEqual(
      pickOutcome({ number, late: false, statusOk: true, scenario: null }),
    );
    expect(old?.paragraphs[0]).toMatch(/горела кухня/);
    expect(
      pickOutcome({ number: "70008301", late: false, statusOk: true }),
    ).toBeNull();
  });
});

describe("исходы набора на финал в data/scenarios", () => {
  const dir = join(repo, "data/scenarios");
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map(
      (name) =>
        JSON.parse(readFileSync(join(dir, name), "utf8")) as {
          code: string;
          card: { number: string };
          outcome?: CardOutcome;
        },
    );
  const final = [
    "smoke-apartment-101-1",
    "traffic-blocked-102-2",
    "unwell-street-103-2",
    "gas-entrance-104-2",
    "not-ours-pipe-104-2",
    "animal-shaft-gkh-1",
  ];

  it("у шести сценариев набора свой исход: полный ход и поздняя «Принята»", () => {
    for (const code of final) {
      const outcome = files.find((file) => file.code === code)?.outcome;
      expect(outcome?.people, code).toBeTruthy();
      expect(outcome?.late, code).toBeTruthy();
    }
  });

  it("снимок разбора 101 с поздней «Принята»: до и после", () => {
    const smoke = files.find((file) => file.code === "smoke-apartment-101-1")!;
    const input = { number: smoke.card.number, late: true, statusOk: true };
    // До: исход тренировки data/practice по номеру карточки — про кухню и газ.
    expect(pickOutcome(input)).toMatchInlineSnapshot(`
      {
        "paragraphs": [
          "Расчёт вскрыл дверь квартиры 115: горела кухня. Пожар потушили, газ на квартиру перекрыли. Хозяина вынесли без сознания и передали скорой — с отравлением дымом его госпитализировали, он жив.",
          "Карточку приняли позже норматива, и выезд начался позже. В закрытой квартире с огнём на кухне дым за эти минуты заполняет комнаты, где лежит человек.",
        ],
        "why": "В комнате с современной мебелью общая вспышка наступает через 3:20–4:50, а на выход у людей меньше 3 минут (UL FSRI).",
      }
    `);
    // После: исход самого сценария — горит проводка за шкафом.
    expect(pickOutcome({ ...input, scenario: smoke.outcome }))
      .toMatchInlineSnapshot(`
      {
        "paragraphs": [
          "Расчёт нашёл очаг: в квартире 115 горела проводка за шкафом. Её обесточили, огонь потушили, квартиру проветрили — дым ушёл. Подъезд был задымлён до самого верха, жильцы выходили сами. Мужчина, который не открывал дверь, оказался без сознания и тяжело дышал; для него вызвали скорую.",
          "Карточку приняли позже норматива, и расчёт выехал позже. Подъезд был задымлён до самого верха, а пожилой мужчина в квартире 115 не открывал дверь: когда расчёт добрался до него, он был без сознания и дышал тяжело.",
        ],
        "why": "В комнате с современной мебелью общая вспышка наступает через 3:20–4:50, а на выход у людей меньше 3 минут (UL FSRI).",
      }
    `);
  });

  it("у 101 — проводка, а не кухня", () => {
    const outcome = files.find(
      (file) => file.code === "smoke-apartment-101-1",
    )?.outcome;
    expect(outcome?.people).toMatch(/проводка/);
    expect(JSON.stringify(outcome)).not.toMatch(/кухн|газ на квартиру/);
  });
});
