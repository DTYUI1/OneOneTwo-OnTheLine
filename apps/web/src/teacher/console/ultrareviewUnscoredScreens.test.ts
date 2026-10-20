import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StaticRouter } from "react-router-dom/server";
import { ResultsPage } from "../../arm/ResultsPage";

vi.mock("../../shared/session", () => ({
  useSession: () => ({
    user: { id: "unscored-user" },
    realtime: { subscribe: () => () => {} },
  }),
}));
vi.mock("../../shared/help/HelpProvider", () => ({ useHelpGuide: () => {} }));
vi.mock("../../arm/help/useHelpEnabled", () => ({
  useHelpEnabled: () => false,
}));

describe("S03: таблица результатов", () => {
  it("сохраняет audit-пояснение, но не выдаёт исключённый ноль за провал", () => {
    const client = new QueryClient();
    client.setQueryData(["cards"], []);
    client.setQueryData(
      ["evaluations", "own", "unscored-user"],
      [
        {
          id: "evaluation",
          card_id: "card",
          total: 0.7,
          version: 1,
          status: "complete",
          teacher_comment: "",
          model_info: { rules: "test" },
          criteria: [
            {
              key: "spelling",
              score: 0,
              weight: 0,
              critical: true,
              explanation: "Нет слов для проверки.",
              evidence: ["Комментарий пуст."],
            },
          ],
        },
      ],
    );
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          StaticRouter,
          { location: "/arm/results" },
          createElement(ResultsPage),
        ),
      ),
    );
    expect(html).toContain("не оценивается");
    expect(html).toContain("Нет слов для проверки.");
    expect(html).toContain("Комментарий пуст.");
    expect(html).not.toContain("Критическая ошибка");
    client.clear();
  });
});
