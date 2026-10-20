import { expect, it } from "vitest";
import type { components } from "../../api-client/schema";
import { courseRows, levelDescription } from "./ScenarioCourse";
type Plan = components["schemas"]["TrainingPlan"];
const plan: Plan = {
  version: 1,
  required_brigade_ids: [],
  observable_defects: [],
  messages: [
    {
      message: { id: "m", version: 1, text: "Выехали", audio: null },
      brigade_id: "b",
      call_target_id: "t",
      available_after_s: 0,
      expected_comment: "",
      justifies_state: "responding",
      requires_state: "accepted",
    },
  ],
  events: [
    {
      id: "e",
      version: 1,
      kind: "readback_error",
      actor: "brigade",
      brigade_id: "b",
      call_target_id: "t",
      channel: "brigade_call",
      priority: "normal",
      trigger: { on: "message", message_id: "m", after_s: 5 },
      line: null,
      expect: [
        { action: "correct_readback", option_key: "correct", within_s: 8 },
      ],
      branches: {
        missed: { line: null, effects: [{ delay: "m2", by_s: 20 }] },
        wrong: {
          line: {
            id: "reply",
            version: 1,
            text: "Адрес не понял",
            audio: null,
          },
          effects: [],
        },
      },
      review: { label: "Адрес", critical: false },
      injectable: false,
    },
  ],
};
it("показывает доклад до события с его моментом, действием и последствиями", () => {
  const rows = courseRows(plan, [
    "received",
    "accepted",
    "responding",
    "completed",
  ]);
  expect(rows.map((r) => r.id)).toEqual(["m", "e"]);
  expect(rows[1].moment).toContain("через 5 с");
  expect(rows[1].actions[0]).toContain("Поправить неверный адрес");
  expect(rows[1].branches).toContain("Нет действия: доклад задержится на 20 с");
  expect(rows[1].branches).toContain("Неверный ответ: Адрес не понял");
});
it("различает требования уровней 3 и 4", () => {
  expect(levelDescription[3]).toContain("два события");
  expect(levelDescription[4]).toContain("тревога или молчание");
});

it("подставляет данные карточки в ожидаемый ответ", () => {
  const question = structuredClone(plan);
  question.events![0].expect = [
    { action: "reply", option_key: "phone", within_s: 8 },
  ];
  question.events![0].reply_options = [
    {
      key: "phone",
      label:
        "Телефон: {caller_phone}; заявитель {caller_name}; адрес {address}",
    },
  ];
  const text = courseRows(question, [
    "received",
    "accepted",
    "responding",
    "completed",
  ])[1].actions[0];
  expect(text).not.toContain("{");
  expect(text).toContain("телефон заявителя из карточки");
});
