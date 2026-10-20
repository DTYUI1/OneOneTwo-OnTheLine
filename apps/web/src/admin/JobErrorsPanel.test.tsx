// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JobErrorsPanel } from "./JobErrorsPanel";
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../shared/api", () => ({
  api: { GET: mocks.get, POST: mocks.post },
  csrfToken: () => "csrf",
}));
let root: Root, host: HTMLDivElement, client: QueryClient;
let readAt: string | null;
const item = () => ({
  id: "job-1",
  kind: "generate",
  attempts: 3,
  last_attempt_at: "2026-10-19T15:00:00Z",
  message: "Не прошла проверка связности",
  version: "a".repeat(64),
  read_at: readAt,
  read_by: readAt ? "admin" : null,
});
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  readAt = null;
  mocks.get.mockImplementation(async () => ({
    data: { items: [item()], total: 1, unread: readAt ? 0 : 1 },
  }));
  mocks.post.mockImplementation(async () => {
    readAt = "2026-10-20T12:00:00Z";
    return { data: item() };
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.clearAllMocks();
});
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}
async function mount() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <JobErrorsPanel />
      </QueryClientProvider>,
    ),
  );
  await flush();
}
function readButton() {
  return [...host.querySelectorAll("button")].find(
    (b) => b.textContent === "Отметить прочитанным",
  )!;
}
it("просмотр не скрывает ошибку, ручная отметка сохраняет запись и обновляет сводку", async () => {
  const invalidate = vi.spyOn(client, "invalidateQueries");
  await mount();
  expect(host.textContent).toContain("Не прошла проверка связности");
  expect(mocks.post).not.toHaveBeenCalled();
  await act(async () => readButton().click());
  await flush();
  expect(mocks.post).toHaveBeenCalledWith("/admin/job-errors/{id}/read", {
    params: { path: { id: "job-1" }, header: { "X-CSRF-Token": "csrf" } },
    body: { version: "a".repeat(64) },
  });
  expect(host.textContent).toContain("Непрочитанных: 0");
  expect(host.textContent).toContain("Не прошла проверка связности");
  expect(readButton()).toBeUndefined();
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin-status"] });
});
it("не скрывает запись при отказе сервера и показывает причину", async () => {
  mocks.post.mockResolvedValue({
    error: { message: "Состояние задания изменилось. Обновите журнал." },
  });
  await mount();
  await act(async () => readButton().click());
  await flush();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Состояние задания изменилось",
  );
  expect(host.textContent).toContain("Непрочитанных: 1");
  expect(readButton()).toBeDefined();
});

it("верхнее и нижнее листание управляют одной страницей", async () => {
  mocks.get.mockImplementation(async (_path, options) => ({
    data: {
      items: [
        {
          ...item(),
          message: `Запись на странице ${options.params.query.offset}`,
        },
      ],
      total: 47,
      unread: 47,
    },
  }));
  await mount();
  const buttons = (text: string) =>
    [...host.querySelectorAll("button")].filter((b) => b.textContent === text);
  expect(buttons("Следующая страница")).toHaveLength(2);
  await act(async () => buttons("Следующая страница")[0].click());
  await flush();
  expect(host.textContent).toContain("Запись на странице 20");
  expect(host.textContent?.match(/Страница 2/g)).toHaveLength(2);
  await act(async () => buttons("Предыдущая страница")[1].click());
  await flush();
  expect(host.textContent).toContain("Запись на странице 0");
  expect(
    buttons("Предыдущая страница").every((button) => button.disabled),
  ).toBe(true);
});
