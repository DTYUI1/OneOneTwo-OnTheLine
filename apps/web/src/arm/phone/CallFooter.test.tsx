import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ButtonHTMLAttributes, ReactElement } from "react";
import { CallFooter } from "./CallFooter";

describe("нижняя плашка разговора", () => {
  it.each([false, true])(
    "сохраняет native disabled=%s, подпись и обработчик отбоя",
    (disabled) => {
      const onHangup = vi.fn();
      const title = disabled ? "Звонок уже заканчивается" : undefined;
      const footer = CallFooter({
        children: "Ответ",
        onHangup,
        disabled,
        title,
      });
      const button = (
        footer.props.children as ReactElement<
          ButtonHTMLAttributes<HTMLButtonElement>
        >[]
      )[1];
      expect(button.type).toBe("button");
      expect(button.props.type).toBe("button");
      expect(button.props.onClick).toBe(onHangup);
      expect(button.props.disabled).toBe(disabled);
      const html = renderToStaticMarkup(footer);
      expect(html).toContain('aria-label="Положить трубку"');
      expect(html).toContain(`title="${title ?? "Положить трубку"}"`);
      expect(html.includes('disabled=""')).toBe(disabled);
      expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    },
  );

  it("после отбоя остаётся ответ без доступной кнопки завершения", () => {
    const html = renderToStaticMarkup(<CallFooter>К контактам</CallFooter>);
    expect(html).toContain("К контактам");
    expect(html).not.toContain('aria-label="Положить трубку"');
  });
});
