import { QueryClient } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { useHandoutCatalog, useScenarios } from "./useConsoleData";
import { catalog, scenarios } from "./handoutCatalog.testFixtures";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  query: vi.fn(
    (options: { queryKey: string[]; queryFn: () => Promise<unknown> }) =>
      options,
  ),
}));
vi.mock("../../shared/api", () => ({ api: { GET: mocks.get } }));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: mocks.query,
}));
beforeEach(() => vi.clearAllMocks());

it("общий GET использует отдельный ключ внутри scenarios и обновляется после правок студии", async () => {
  mocks.get.mockResolvedValue({ data: catalog });
  useHandoutCatalog();
  const options = mocks.query.mock.calls[0][0];
  expect(options.queryKey).toEqual(["scenarios", "practice-catalog"]);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  try {
    expect(await client.fetchQuery(options)).toEqual(catalog);
    expect(mocks.get).toHaveBeenCalledWith("/practice/catalog");
    await client.invalidateQueries({ queryKey: ["scenarios"] });
    expect(client.getQueryState(options.queryKey)?.isInvalidated).toBe(true);
  } finally {
    client.clear();
  }
});

it("ошибка общего каталога остаётся ошибкой, а не пустым или полным ассортиментом", async () => {
  mocks.get.mockResolvedValue({ error: { message: "Доступ запрещён" } });
  useHandoutCatalog();
  await expect(mocks.query.mock.calls[0][0].queryFn()).rejects.toThrow(
    "Доступ запрещён",
  );
  expect(mocks.get).toHaveBeenCalledTimes(1);
  expect(mocks.get).toHaveBeenCalledWith("/practice/catalog");
});

it("полный список студии и истории сохраняет собственный GET и состав", async () => {
  mocks.get.mockResolvedValue({ data: scenarios });
  useScenarios();
  const options = mocks.query.mock.calls[0][0];
  expect(options.queryKey).toEqual(["scenarios"]);
  expect(await options.queryFn()).toEqual(scenarios);
  expect(mocks.get).toHaveBeenCalledWith("/scenarios");
  expect(scenarios.some((item) => item.id === "hidden")).toBe(true);
});
