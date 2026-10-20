// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FinishDialog } from "./FinishPrompt";
import type { components } from "../../api-client/schema";
const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("../../shared/api", () => ({
  api: { POST: mocks.post },
  csrfToken: () => "csrf",
}));
const lesson = {
  id: "lesson",
  title: "Занятие",
  status: "running",
} as components["schemas"]["Session"];
let root: Root, host: HTMLDivElement, client: QueryClient;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  client = new QueryClient();
  client.setQueryData(["sessions"], [lesson]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.useRealTimers();
  vi.resetAllMocks();
});
async function mount() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <FinishDialog session={lesson} onKeep={() => {}} />
      </QueryClientProvider>,
    ),
  );
}
it("после возвращения к вкладке завершает занятие и закрывает окно, не оставляя ноль", async () => {
  mocks.post.mockResolvedValue({ data: { ...lesson, status: "finished" } });
  await mount();
  await act(async () => {
    vi.setSystemTime(Date.now() + 121000);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(mocks.post).toHaveBeenCalledOnce();
  expect(client.getQueryData(["sessions"])).toEqual([
    { ...lesson, status: "finished" },
  ]);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it("ошибка завершения видна и допускает повтор с тем же request_id", async () => {
  mocks.post
    .mockResolvedValueOnce({ error: { message: "Нет связи" } })
    .mockResolvedValue({ data: { ...lesson, status: "finished" } });
  await mount();
  await act(async () => {
    vi.setSystemTime(Date.now() + 121000);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "Нет связи",
  );
  await act(async () => {
    (host.querySelector("button") as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(mocks.post.mock.calls[0][1].body.request_id).toBe(
    mocks.post.mock.calls[1][1].body.request_id,
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
