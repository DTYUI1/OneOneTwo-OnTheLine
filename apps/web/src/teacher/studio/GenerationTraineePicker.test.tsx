// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import {
  GenerationTraineePicker,
  type GenerationTrainee,
} from "./GenerationTraineePicker";
const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../shared/api", () => ({ api: { GET: mocks.get } }));
vi.mock("../../shared/FieldHelp", () => ({ FieldHelp: () => null }));

it("ищет по имени и показывает ФИО с логином без уровня, сохраняя выбранного обучаемого", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const trainee = {
    id: "one",
    login: "trainee03",
    full_name: "Кузнецов Максим Андреевич",
    recommended_level: 2,
    dds_service_id: "101",
    explanation: "Рекомендация",
  };
  mocks.get.mockResolvedValue({ data: [trainee] });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Harness() {
    const [value, setValue] = useState<GenerationTrainee | null>(null);
    return (
      <GenerationTraineePicker
        value={value}
        serviceId="101"
        disabled={false}
        onChange={setValue}
      />
    );
  }
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>,
      ),
    );
    const input = host.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "Кузнецов");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(mocks.get).toHaveBeenCalledWith("/packs/generation-trainees", {
      params: { query: { login: "Кузнецов", service_id: "101" } },
    });
    const list = host.querySelector('[aria-label="Найденные обучаемые"]')!;
    expect(list.textContent).toBe("Кузнецов Максим Андреевич (trainee03)");
    expect(list.textContent).not.toContain("уровень");
    await act(async () => list.querySelector("button")!.click());
    expect(input.value).toBe("Кузнецов Максим Андреевич (trainee03)");
    expect(host.querySelector('[aria-label="Найденные обучаемые"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  }
});
