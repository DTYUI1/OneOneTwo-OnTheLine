import { describe, expect, it } from "vitest";
import { loginDestination } from "./loginDestination";

describe("Возврат после входа", () => {
  it.each([
    "/arm",
    "/arm/cards/00000000-0000-4000-8000-000000000100",
    "/arm/cards/unknown",
    "/arm/results",
    "/arm/reference",
    "/results?session=123#review",
  ])("сохраняет адрес обучаемого: %s", (path) => {
    expect(loginDestination("trainee", path)).toBe(path);
  });

  it("сохраняет доступные кабинеты преподавателя и администратора", () => {
    expect(loginDestination("teacher", "/teacher")).toBe("/teacher");
    expect(loginDestination("admin", "/teacher")).toBe("/teacher");
    expect(loginDestination("admin", "/admin")).toBe("/admin");
  });

  it("выбирает свою главную страницу при входе под другой ролью", () => {
    expect(loginDestination("trainee", "/admin")).toBe("/arm");
    expect(loginDestination("trainee", "/teacher")).toBe("/arm");
    expect(loginDestination("teacher", "/admin")).toBe("/teacher");
    expect(loginDestination("teacher", "/arm/cards/123")).toBe("/teacher");
    expect(loginDestination("admin", "/arm/cards/123")).toBe("/admin");
  });

  it.each([
    undefined,
    null,
    {},
    123,
    "",
    "/login",
    "/unknown",
    "https://example.org/arm",
    "//example.org/arm",
    "/\\example.org/arm",
    "javascript:alert(1)",
    "/arm/cards/../../admin",
    "/arm/cards/%2e%2e%2fadmin",
  ])("отбрасывает неподходящий адрес: %j", (path) => {
    expect(loginDestination("trainee", path)).toBe("/arm");
  });
});
