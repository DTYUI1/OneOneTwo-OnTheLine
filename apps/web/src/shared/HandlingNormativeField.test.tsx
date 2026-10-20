import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import contract from "../../../../contracts/openapi.json";
import { SettingsFields } from "../admin/SettingsForm";
import type { Settings } from "../admin/adminModel";
import type { Session } from "../teacher/console/model";
import { SessionNorms } from "../teacher/console/SessionNorms";

const settings: Settings = {
  ...contract.components.schemas.Settings.examples[0],
  final_shift: false,
  demo: false,
};

describe("Поле отработки карточки", () => {
  it("в создании занятия и настройках класса показывает 3:00 вместо секунд", () => {
    const html = renderToStaticMarkup(
      <SettingsFields value={settings} onChange={() => {}} weightHint="" />,
    );
    expect(html).toContain("Отработка карточки");
    expect(html).toContain('value="3:00"');
    expect(html).not.toContain("Отработка, с");
    expect(html).toContain("Реакция, с");
    expect(html).toContain('value="30"');
  });

  it.each(["draft", "running", "finished"] as const)(
    "на раздаче использует норматив занятия (%s)",
    (status) => {
      const session = {
        id: "lesson",
        status,
        settings_snapshot: { ...settings, handling_normative_s: 245 },
      } as Session;
      const html = renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          <SessionNorms session={session} />
        </QueryClientProvider>,
      );
      if (status === "draft") {
        expect(html).toContain('value="4:05"');
        expect(html).toContain("<input");
      } else {
        expect(html).toContain("Отработка карточки: 4:05");
        expect(html).not.toContain("<input");
      }
      expect(html).toContain("Ожидание доклада бригады не считается.");
    },
  );
});
