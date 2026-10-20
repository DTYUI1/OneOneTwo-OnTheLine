// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { usePracticeStart } from "./usePracticeStart";
const mocks = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock("../../shared/api", () => ({
  api: { GET: mocks.get, POST: mocks.post },
  csrfToken: () => "csrf",
}));
it("блокирует запуск при занятии преподавателя и разрешает после завершения", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(
    ["sessions"],
    [{ id: "lesson", kind: "lesson", status: "running" }],
  );
  client.setQueryData(["cards"], []);
  mocks.post.mockResolvedValue({ error: { message: "Проверка запуска" } });
  mocks.get.mockResolvedValue({ data: [] });
  let practice!: ReturnType<typeof usePracticeStart>;
  function Probe() {
    practice = usePracticeStart();
    return <button disabled={practice.disabled}>Запуск</button>;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={client}>
            <Probe />
          </QueryClientProvider>
        </MemoryRouter>,
      ),
    );
    expect(practice.blockedReason).toContain("Идёт занятие преподавателя");
    expect(host.querySelector("button")!.disabled).toBe(true);
    await act(async () => practice.start({ mode: "solo" }));
    expect(mocks.post).not.toHaveBeenCalled();
    await act(async () => {
      client.setQueryData(
        ["sessions"],
        [
          { id: "lesson", kind: "lesson", status: "finished" },
          { id: "practice", kind: "practice", status: "running" },
        ],
      );
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(practice.blockedReason).toBe("");
    expect(host.querySelector("button")!.disabled).toBe(false);
    await act(async () => practice.start({ mode: "solo" }));
    expect(mocks.post).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    vi.clearAllMocks();
  }
});

it("кнопка и этапы разделяют блокировку запуска и освобождаются после ошибки", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(["sessions"], []);
  client.setQueryData(["cards"], []);
  let first!: ReturnType<typeof usePracticeStart>,
    second!: ReturnType<typeof usePracticeStart>;
  function Probe() {
    first = usePracticeStart();
    second = usePracticeStart();
    return null;
  }
  let resolve!: (value: unknown) => void;
  mocks.post.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  mocks.get.mockResolvedValue({ data: [] });
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={client}>
            <Probe />
          </QueryClientProvider>
        </MemoryRouter>,
      ),
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = first.start({ mode: "solo" });
      await second.start({ mode: "watch" });
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(mocks.post).toHaveBeenCalledOnce();
    expect(first.disabled).toBe(true);
    expect(second.disabled).toBe(true);
    await act(async () => {
      resolve({ error: { message: "Упражнение недоступно" } });
      await pending;
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(first.disabled).toBe(false);
    expect(second.disabled).toBe(false);
    expect(second.note).toBe("Упражнение недоступно");
  } finally {
    await act(async () => root.unmount());
    client.clear();
    vi.clearAllMocks();
  }
});
