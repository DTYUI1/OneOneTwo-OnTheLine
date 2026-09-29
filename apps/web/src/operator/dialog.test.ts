import { describe, expect, it } from "vitest";
import { OPERATOR_DATA as data } from "./data";
import {
  CONFIRM_KEY,
  STEP_TITLES,
  TONES,
  actBody,
  calmPhrase,
  escalationDue,
  firstLines,
  questionnaireFor,
  readbackText,
  startState,
  stepOf,
  stepOptions,
} from "./dialog";
import { EMPTY_ADDRESS } from "./model";

const CARD_ADDRESS = {
  ...EMPTY_ADDRESS,
  street: "Дубнинская улица",
  house: "12",
  apartment: "47",
};

const typeOf = (code: string) => data.types.find((row) => row.code === code);
const byId = (id: string) => data.scenarios.find((row) => row.id === id)!;

describe("разговор с заявителем", () => {
  it("у каждого сценария есть первая реплика с голосом", () => {
    for (const scenario of data.scenarios) {
      expect(firstLines(scenario)).toEqual([
        {
          who: "caller",
          text: scenario.opening,
          voice: `${scenario.id}/opening`,
        },
      ]);
    }
  });

  it("подсказки — из карты группы выбранного типа", () => {
    expect(questionnaireFor(data, typeOf("1050102"))?.id).toBe(
      "fire_apartment",
    );
    expect(questionnaireFor(data, undefined)).toBeUndefined();
  });

  it("верный тип сценария даёт карту сценария", () => {
    const codes: Record<string, string> = {
      dtp_victims_fuel: "2020900",
      elevator_stuck: "14100102",
      fire_apartment_smoke: "1050102",
      heart_attack_home: "22370000",
    };
    for (const scenario of data.scenarios.filter((s) => s.questionnaire_id)) {
      expect(questionnaireFor(data, typeOf(codes[scenario.id]!))?.id).toBe(
        scenario.questionnaire_id,
      );
    }
  });

  it("тело запроса: вопрос, приём, совет, пауза", () => {
    const state = startState({ start_panic: 3 });
    expect(
      actBody("s", state, { kind: "question", question: { text: "Где?" } }),
    ).toEqual({ scenario_id: "s", state, text: "Где?" });
    expect(
      actBody("s", state, {
        kind: "question",
        question: { questionnaireId: "c", key: "floor" },
      }),
    ).toEqual({ scenario_id: "s", state, questionnaire_id: "c", key: "floor" });
    expect(actBody("s", state, { kind: "calm", calm: "reason" })).toEqual({
      scenario_id: "s",
      state,
      action: "calm",
      kind: "reason",
    });
    expect(actBody("s", state, { kind: "advice", key: "stay" })).toEqual({
      scenario_id: "s",
      state,
      action: "advice",
      kind: "stay",
    });
    expect(actBody("s", state, { kind: "silence" })).toEqual({
      scenario_id: "s",
      state,
      action: "silence",
    });
    // Этап 3: лишний вопрос — по ключу; к вопросу — адрес карточки для повтора адреса.
    expect(
      actBody(
        "s",
        state,
        { kind: "question", question: { distractor: "pets" } },
        CARD_ADDRESS,
      ),
    ).toEqual({
      scenario_id: "s",
      state,
      distractor: "pets",
      address: {
        street: "Дубнинская улица",
        house: "12",
        building: "",
        apartment: "47",
      },
    });
    // Адрес — только к вопросу: заявителю на «Успокоить» он не нужен.
    expect(
      actBody("s", state, { kind: "hold" }, CARD_ADDRESS),
    ).not.toHaveProperty("address");
  });
});

describe("шаги опроса (этап 3)", () => {
  it("пять шагов по стандарту приёма вызова", () => {
    expect(STEP_TITLES).toEqual([
      "Адрес",
      "Номер для связи",
      "Что случилось",
      "Угроза людям",
      "Детали и доступ",
    ]);
  });

  it("на шаге 3–4 варианта: вопросы карты шага и лишние вопросы того же шага", () => {
    for (const scenario of data.scenarios) {
      const card = data.questionnaires.find(
        (item) => item.id === scenario.questionnaire_id,
      )!;
      const seen: string[] = [];
      for (let step = 1; step <= STEP_TITLES.length; step++) {
        const options = stepOptions(data, scenario, step, CARD_ADDRESS);
        expect(options.length).toBeGreaterThanOrEqual(3);
        expect(options.length).toBeLessThanOrEqual(4);
        expect(options.some((option) => "distractor" in option.question)).toBe(
          true,
        );
        for (const option of options)
          expect(stepOf(data, scenario, option.key)).toBe(step);
        // Порядок у сценария и шага всегда один и тот же.
        expect(stepOptions(data, scenario, step, CARD_ADDRESS)).toEqual(
          options,
        );
        seen.push(...options.map((option) => option.key));
      }
      // По всем шагам — вся карта и все лишние вопросы, без повторов.
      expect(seen.sort()).toEqual(
        [
          ...card.questions.map((question) => question.key),
          ...scenario.distractors.map((item) => item.key),
        ].sort(),
      );
    }
  });

  it("повтор адреса звучит адресом карточки", () => {
    const fire = data.scenarios.find((s) => s.id === "fire_apartment_smoke")!;
    const confirm = (address: typeof EMPTY_ADDRESS) =>
      stepOptions(data, fire, 1, address).find(
        (option) => option.key === CONFIRM_KEY,
      )?.label;
    expect(confirm(CARD_ADDRESS)).toBe(
      "Проверю адрес: Дубнинская улица, дом 12, квартира 47. Верно?",
    );
    expect(confirm(EMPTY_ADDRESS)).toBeUndefined();
    expect(confirm({ ...EMPTY_ADDRESS, street: "  " })).toBeUndefined();
    for (const scenario of data.scenarios) {
      expect(stepOptions(data, scenario, 1, EMPTY_ADDRESS)).toHaveLength(3);
      expect(stepOptions(data, scenario, 1, CARD_ADDRESS)).toHaveLength(4);
    }
    expect(
      readbackText("Проверю адрес: {address}. Верно?", {
        ...CARD_ADDRESS,
        apartment: "",
        korpus: "2",
      }),
    ).toBe("Проверю адрес: Дубнинская улица, дом 12, корпус 2. Верно?");
  });
});

describe("живой звонок (этап 2)", () => {
  it("четыре персонажа: девушка в истерике, ребёнок и пожилая — в панике", () => {
    const panic = Object.fromEntries(
      data.scenarios.map((s) => [s.persona.kind, s.start_panic]),
    );
    expect(panic).toEqual({ young_woman: 3, adult: 1, elderly: 2, child: 2 });
    for (const scenario of data.scenarios) {
      expect(startState(scenario).panic).toBe(scenario.start_panic);
      expect(scenario.advice.length).toBeGreaterThan(0);
    }
  });

  it("просьба с причиной просит адрес, пока его нет", () => {
    const state = startState({ start_panic: 3 });
    expect(calmPhrase("reason", state)).toContain("Мне нужен адрес");
    expect(
      calmPhrase("reason", { ...state, facts: ["address"] }),
    ).not.toContain("адрес");
    expect(calmPhrase("order", state)).toBe("Успокойтесь!");
  });

  it("ухудшение: после своего вопроса и не раньше срока, самое позднее — latest_s", () => {
    const scenario = byId("fire_apartment_smoke");
    const escalation = scenario.escalation!;
    const state = startState(scenario);
    const asked = { ...state, asked: [escalation.after_question] };
    expect(escalationDue(scenario, state, escalation.after_s)).toBe(false);
    expect(escalationDue(scenario, asked, escalation.after_s - 1)).toBe(false);
    expect(escalationDue(scenario, asked, escalation.after_s)).toBe(true);
    expect(escalationDue(scenario, state, escalation.latest_s)).toBe(true);
    expect(escalationDue(scenario, { ...asked, escalated: true }, 999)).toBe(
      false,
    );
  });

  it("тон — словами, без цифр", () => {
    expect(TONES).toHaveLength(4);
    for (const tone of TONES) expect(tone).not.toMatch(/\d/);
  });
});
