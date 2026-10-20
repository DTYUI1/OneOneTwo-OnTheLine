// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AdminWarningBanner } from "./AdminWarningBanner";

it("крестик скрывает только текущую сводку; новая ошибка возвращает полосу", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  const root = createRoot(host);
  const onHealth = vi.fn(),
    onJobErrors = vi.fn();
  const render = async (count: number | null, hidden = false) => {
    await act(async () =>
      root.render(
        <AdminWarningBanner
          warnings={
            count === null ? [] : [`Непрочитанных ошибок очереди: ${count}.`]
          }
          hidden={hidden}
          hasQueueErrors
          onHealth={onHealth}
          onJobErrors={onJobErrors}
        />,
      ),
    );
  };
  try {
    await render(44);
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          '[aria-label="Скрыть предупреждение"]',
        )!
        .click(),
    );
    expect(host.textContent).toBe("");
    expect(onHealth).not.toHaveBeenCalled();
    expect(onJobErrors).not.toHaveBeenCalled();
    await render(44, true);
    await render(44);
    expect(host.textContent).toBe("");
    // Причина устранена; повтор с тем же текстом не должен оставаться скрытым.
    await render(null);
    await render(44);
    expect(host.textContent).toContain("Непрочитанных ошибок очереди: 44.");
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          '[aria-label="Скрыть предупреждение"]',
        )!
        .click(),
    );
    expect(host.textContent).toBe("");
    await render(45);
    expect(host.textContent).toContain("Непрочитанных ошибок очереди: 45.");
  } finally {
    await act(async () => root.unmount());
  }
});
