import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CoherenceBadge, CoherenceWarning } from "./CoherenceWarning";

it("показывает пометку только для непроверенного сценария", () => {
  expect(renderToStaticMarkup(<CoherenceBadge unchecked />)).toContain(
    "Сценарий не проверен автоматически",
  );
  expect(renderToStaticMarkup(<CoherenceBadge unchecked={false} />)).toBe("");
});

it("предупреждает перед утверждением, не подтверждает автоматически", () => {
  const choose = vi.fn();
  const html = renderToStaticMarkup(<CoherenceWarning onChoose={choose} />);
  expect(html).toContain("<dialog");
  expect(html).toContain("Утвердить без проверки");
  expect(html).toContain("Вернуться к проверке");
  expect(choose).not.toHaveBeenCalled();
});
