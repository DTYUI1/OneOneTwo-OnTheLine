import { expect, it } from "vitest";
import { catalogScenarios } from "./handoutCatalog";
import { catalog, scenario, scenarios } from "./handoutCatalog.testFixtures";

it("показывает новые ИИ-карточки первыми, сохраняя порядок остальных", () => {
  const full = [
    { ...scenario("template"), created_at: "2026-10-20T15:00:00Z" },
    {
      ...scenario("ai-old"),
      origin: "llm" as const,
      created_at: "2026-10-20T09:00:00Z",
    },
    { ...scenario("imported"), origin: "imported" as const },
    {
      ...scenario("ai-new"),
      origin: "llm" as const,
      created_at: "2026-10-20T13:00:00+03:00",
    },
    { ...scenario("ai-undated"), origin: "llm" as const },
    { ...scenario("ai-invalid"), origin: "llm" as const, created_at: "bad" },
    {
      ...scenario("ai-tie"),
      origin: "llm" as const,
      created_at: "2026-10-20T10:00:00Z",
    },
  ];
  const items = full.map((item) => ({ ...catalog[1], id: item.id }));
  const before = full.map((item) => item.id);
  expect(catalogScenarios(items, full).map((item) => item.id)).toEqual([
    "ai-new",
    "ai-tie",
    "ai-old",
    "ai-undated",
    "ai-invalid",
    "template",
    "imported",
  ]);
  expect(full.map((item) => item.id)).toEqual(before);
  expect(items.map((item) => item.id)).toEqual(before);
});

it("сохраняет порядок каталога, точный заголовок и поля полной версии для выдачи", () => {
  const result = catalogScenarios(catalog, scenarios);
  expect(result.map((item) => item.id)).toEqual(catalog.map((item) => item.id));
  expect(result[1].catalog.title).toBe(catalog[1].title);
  expect(result[1].reference).toBe(scenarios[3].reference);
  expect(result[1].version).toBe(scenarios[3].version);
  expect(scenarios).toHaveLength(4);
});

it("не придумывает полную карточку отсутствующего или неутверждённого сценария", () => {
  expect(
    catalogScenarios(catalog, [
      { ...scenario("foreign"), status: "draft" },
      { ...scenario("lift-first"), status: "retired" },
    ]),
  ).toEqual([]);
});

it("показывает обязательный звонок заявителю даже при единственном clarify", () => {
  const lift = catalogScenarios([catalog[1]], [scenario("lift-first")])[0];
  expect(lift.specifics).toBe("звонок заявителю, уточнение");
});

it("специфика — только trains и обязательная роль, не заголовок и не тип происшествия", () => {
  const item = scenario("foreign");
  item.reference.expected_call.required = false;
  const [result] = catalogScenarios(
    [
      {
        ...catalog[0],
        title: "Позвонить заявителю: пожар и лифт",
        trains: [
          "readback_error",
          "clarify",
          "request_service",
          "silence",
          "alarm",
          "future",
          "clarify",
        ],
      },
    ],
    [item],
  );
  expect(result.specifics).toBe(
    "ловушка повтора адреса, уточнение, просьба вызвать службу, молчание бригады, тревога",
  );
  expect(
    catalogScenarios([{ ...catalog[0], trains: [] }], [item])[0].specifics,
  ).toBe("");
  item.reference.expected_call.required = true;
  item.reference.expected_call.contact_role = "crew_chief";
  expect(catalogScenarios([catalog[0]], [item])[0].specifics).not.toContain(
    "звонок заявителю",
  );
});

it.each([
  { origin: "template" as const, label: "Шаблон" },
  { origin: "llm" as const, label: "ИИ" },
  { origin: "imported" as const, label: "Импорт" },
  { origin: "trainee" as const, label: "Обучаемый" },
])("номер карточки и источник в названии: $origin", ({ origin, label }) => {
  const full = { ...scenario("lift-first"), origin };
  const [result] = catalogScenarios([catalog[1]], [full]);
  expect(result).toHaveProperty(
    "displayTitle",
    `№ 70008602 · ${catalog[1].title} · ${label}`,
  );
  expect(result.catalog.title).toBe(catalog[1].title);
  expect(result.origin).toBe(origin);
});

it.each([
  { catalogVersion: 2, scenarioVersion: 3 },
  { catalogVersion: 3, scenarioVersion: 2 },
])(
  "excludes mismatched versions: catalog $catalogVersion / full $scenarioVersion",
  ({ catalogVersion, scenarioVersion }) => {
    const full = { ...scenario("lift-first"), version: scenarioVersion };
    full.reference.expected_call.required = false;
    expect(
      catalogScenarios(
        [{ ...catalog[1], version: catalogVersion }, catalog[2]],
        [full, scenario("lift-second")],
      ).map((item) => item.id),
    ).toEqual(["lift-second"]);
  },
);
