import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RepeatGenerationDialog } from "./RepeatGenerationDialog";

it.each([
  [0, 1],
  [2, 5],
])("предупреждает о повторах: осталось %i, запрошено %i", (left, count) => {
  const html = renderToStaticMarkup(
    <RepeatGenerationDialog left={left} count={count} onChoose={vi.fn()} />,
  );
  expect(html).toContain("<dialog");
  expect(html).toContain("Сгенерировать</button>");
  expect(html).toContain("Отмена</button>");
  expect(html).not.toContain("После занятия");
  expect(html).toContain(
    left === 0 ? "Все варианты карточек" : "Следующие 3 карточек",
  );
});

it.each([
  [5, 5],
  [6, 2],
])("не спрашивает при достаточном остатке: %i, запрос %i", (left, count) => {
  expect(
    renderToStaticMarkup(
      <RepeatGenerationDialog left={left} count={count} onChoose={vi.fn()} />,
    ),
  ).toBe("");
});
