import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AttemptScore } from "./Review";
import { EMPTY_ADDRESS } from "./model";
import { cardInput, type AttemptResult } from "./save";

describe("полная карточка в разборе", () => {
  const card = cardInput({
    incidentTypeCode: null,
    tags: new Set(),
    services: [],
    address: {
      ...EMPTY_ADDRESS,
      entrance: "2",
      floor: "5",
      descriptive: "Напротив школы",
    },
    description: "",
    callerName: "",
    callerStatus: "ребенок",
    phoneProvided: "",
    phoneScene: "",
    offSite: false,
  });
  const result: AttemptResult = {
    id: "attempt",
    scenario_id: "elevator_stuck",
    scenario_title: "Лифт",
    created_at: "2026-10-07T12:00:00Z",
    total: 100,
    max_total: 100,
    journal: { events: [], steps: [] },
    operator_card: card,
    criteria: [
      {
        key: "address",
        title: "Адрес",
        weight: 20,
        score: 1,
        points: 20,
        explanation: "Адрес указан верно.",
      },
      {
        key: "caller",
        title: "Работа с заявителем",
        weight: 10,
        score: 1,
        points: 10,
        explanation: "Статус заявителя указан верно: ребенок.",
      },
    ],
  };

  it("показывает сохранённые подъезд, этаж, ориентир и пояснение статуса", () => {
    const html = renderToStaticMarkup(
      <AttemptScore result={result} scenario={undefined} />,
    );
    for (const text of [
      "Подъезд: 2",
      "Этаж: 5",
      "Описательный адрес: Напротив школы",
      "Статус заявителя указан верно: ребенок.",
    ])
      expect(html).toContain(text);
  });

  it("открывает старые попытки без полной карточки", () => {
    const html = renderToStaticMarkup(
      <AttemptScore
        result={{ ...result, operator_card: null }}
        scenario={undefined}
      />,
    );
    expect(html).toContain("100 из 100");
    expect(html).not.toContain("Сохранённый адрес");
  });
});
