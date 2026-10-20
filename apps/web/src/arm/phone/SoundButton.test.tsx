import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { SoundButton } from "./SoundButton";

describe("значок звука разговора", () => {
  it.each([false, true])(
    "звук выключен: %s — доступный SVG вместо текста",
    (muted) => {
      const html = renderToStaticMarkup(
        <SoundButton muted={muted} onToggle={vi.fn()} />,
      );
      const label = muted
        ? "Включить звук разговора"
        : "Выключить звук разговора";
      expect(html).toContain(`aria-label="${label}"`);
      expect(html).toContain(`title="${label}"`);
      expect(html).toContain(`aria-pressed="${!muted}"`);
      expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
      expect(html).not.toMatch(/звук (?:вкл|выкл)\./);
    },
  );

  it("состояния отличаются графикой, обработчик переключает исходное значение", () => {
    const onToggle = vi.fn();
    const icon = (muted: boolean) => {
      const button = SoundButton({ muted, onToggle }) as ReactElement<{
        onClick: () => void;
      }>;
      button.props.onClick();
      return renderToStaticMarkup(button).match(/<svg[\s\S]*?<\/svg>/)?.[0];
    };
    expect(icon(false)).not.toBe(icon(true));
    expect(onToggle.mock.calls).toEqual([[true], [false]]);
  });
});
