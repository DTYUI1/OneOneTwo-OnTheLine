import { describe, expect, it } from "vitest";
import { showsOperatorLink } from "./Shell";

describe("шапка: ссылка «Оператор 112»", () => {
  it("у преподавателя её нет даже при включённом модуле", () => {
    expect(showsOperatorLink("teacher", true)).toBe(false);
  });
  it("у обучаемого есть при включённом модуле", () => {
    expect(showsOperatorLink("trainee", true)).toBe(true);
  });
  it("при выключенном модуле её нет ни у кого", () => {
    expect(showsOperatorLink("trainee", false)).toBe(false);
  });
});
