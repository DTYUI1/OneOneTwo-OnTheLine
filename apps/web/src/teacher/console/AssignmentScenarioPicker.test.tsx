// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AssignmentScenarioPicker } from "./AssignmentScenarioPicker";
import type { Scenario } from "./model";

it("ищет по полному и частичному номеру, сохраняет группы служб и добавляет выбранный вариант", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const choose = vi.fn();
  const scenarios = [
    ["own", "96354311", "GKH"],
    ["other", "96354312", "102"],
    ["last", "12345678", "GKH"],
  ].map(([id, number, target_service_id]) => ({
    id,
    target_service_id,
    level: 1,
    card: { number, incident_class: "Тест" },
  })) as Scenario[];
  try {
    await act(async () =>
      root.render(
        <AssignmentScenarioPicker
          scenarios={scenarios}
          participant={{ dds_service_id: "GKH", workstation_number: 7 }}
          serviceName={(id) => id}
          onChoose={choose}
        />,
      ),
    );
    const input = host.querySelector("input")!;
    const menu = () => document.querySelector('[role="listbox"]');
    const options = () => [
      ...document.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ];
    const type = async (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    expect(host.querySelectorAll("input")).toHaveLength(1);
    expect(host.querySelector("select")).toBeNull();
    await act(async () => input.focus());
    expect(options()).toHaveLength(3);
    await type("9635431");
    expect(options()).toHaveLength(2);
    expect(
      menu()?.querySelector('[role="group"][aria-label="Своя служба"]')
        ?.textContent,
    ).toContain("96354311");
    expect(
      menu()?.querySelector('[role="group"][aria-label^="Чужая служба"]')
        ?.textContent,
    ).toContain("96354312");
    await type("96354311");
    expect(options()).toHaveLength(1);
    await act(async () => options()[0].click());
    expect(choose).toHaveBeenLastCalledWith(scenarios[0]);
    expect(menu()).toBeNull();
    expect(input.value).toBe("");
    await act(async () => input.click());
    expect(options()).toHaveLength(3);
    await type("00000000");
    expect(menu()?.textContent).toContain("Сценарии не найдены");
    await type("");
    expect(options()).toHaveLength(3);
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
      ),
    );
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(choose).toHaveBeenLastCalledWith(scenarios[1]);
    expect(menu()).toBeNull();
    await act(async () => input.click());
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(menu()).toBeNull();
    await act(async () => input.click());
    await act(async () => input.blur());
    expect(menu()).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("сортирует по уровню и дате внутри служб, не смешивая группы", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const scenarios = [
    {
      id: "own4",
      level: 4,
      target_service_id: "GKH",
      created_at: "2026-10-03",
    },
    {
      id: "other1",
      level: 1,
      target_service_id: "102",
      created_at: "2026-10-05",
    },
    {
      id: "own1",
      level: 1,
      target_service_id: "GKH",
      created_at: "2026-10-02",
    },
    { id: "other4", level: 4, target_service_id: "102", created_at: null },
    {
      id: "own3",
      level: 3,
      target_service_id: "GKH",
      created_at: "2026-10-01",
    },
  ].map((s) => ({
    ...s,
    card: { number: s.id, incident_class: "Тест" },
  })) as Scenario[];
  try {
    await act(async () =>
      root.render(
        <AssignmentScenarioPicker
          scenarios={scenarios}
          participant={{ dds_service_id: "GKH", workstation_number: 5 }}
          serviceName={(id) => id}
          onChoose={vi.fn()}
        />,
      ),
    );
    await act(async () => host.querySelector("input")!.focus());
    const order = () =>
      [...document.querySelectorAll('[role="option"]')].map(
        (e) => e.textContent?.split(" · ")[0],
      );
    const select = document.querySelector("select")!;
    expect(select.value).toBe("date-desc");
    expect(order()).toEqual([
      "№ own4",
      "№ own1",
      "№ own3",
      "№ other1",
      "№ other4",
    ]);
    const change = async (value: string) =>
      act(async () => {
        select.focus();
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    await change("level-asc");
    expect(order()).toEqual([
      "№ own1",
      "№ own3",
      "№ own4",
      "№ other1",
      "№ other4",
    ]);
    await change("level-desc");
    expect(order()).toEqual([
      "№ own4",
      "№ own3",
      "№ own1",
      "№ other4",
      "№ other1",
    ]);
    await change("date-desc");
    expect(order()).toEqual([
      "№ own4",
      "№ own1",
      "№ own3",
      "№ other1",
      "№ other4",
    ]);
    await change("date-asc");
    expect(order()).toEqual([
      "№ own3",
      "№ own1",
      "№ own4",
      "№ other1",
      "№ other4",
    ]);
    await act(async () => select.blur());
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
