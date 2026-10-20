import { describe, expect, it } from "vitest";
import {
  creationTime,
  NEWEST_FIRST,
  nextSort,
  sortedRows,
  type SortState,
} from "./sorting";

const rows = [
  {
    id: "old",
    number: "10",
    level: 2,
    service: "Служба 102",
    created_at: "2025-01-01T00:00:00Z",
  },
  {
    id: "new",
    number: "2",
    level: 4,
    service: "ЖКХ",
    created_at: "2025-02-01T03:00:00+03:00",
  },
  {
    id: "unknown",
    number: "1",
    level: 1,
    service: "Служба 101",
    created_at: null,
  },
];
const ids = (sort: SortState) =>
  sortedRows(rows, sort, (row, key) =>
    key === "created_at"
      ? creationTime(row.created_at)
      : row[key as "number" | "level" | "service"],
  ).map((row) => row.id);

describe("сортировка студии и пакетов", () => {
  it("по умолчанию новые сверху, без даты — в конце", () => {
    expect(ids(NEWEST_FIRST)).toEqual(["new", "old", "unknown"]);
    expect(ids({ key: "created_at", direction: "asc" })).toEqual([
      "old",
      "new",
      "unknown",
    ]);
    expect(rows[0].id).toBe("old");
  });
  it("номера сравнивает численно, строки — по русскому алфавиту", () => {
    expect(ids({ key: "number", direction: "asc" })).toEqual([
      "unknown",
      "new",
      "old",
    ]);
    expect(ids({ key: "level", direction: "desc" })).toEqual([
      "new",
      "old",
      "unknown",
    ]);
    expect(ids({ key: "service", direction: "asc" })).toEqual([
      "new",
      "unknown",
      "old",
    ]);
  });
  it("повторный клик меняет направление; новый столбец начинается по возрастанию", () => {
    const ascending = nextSort(NEWEST_FIRST, "number");
    expect(ascending).toEqual({ key: "number", direction: "asc" });
    expect(nextSort(ascending, "number").direction).toBe("desc");
    expect(nextSort(ascending, "level").direction).toBe("asc");
  });
  it("равные даты сохраняют порядок, сравнивает время с учётом часового пояса", () => {
    expect(creationTime("2025-02-01T03:00:00+03:00")).toBe(
      creationTime("2025-02-01T00:00:00Z"),
    );
    expect(creationTime("bad")).toBeNull();
    expect(sortedRows(["b", "a"], NEWEST_FIRST, () => 1)).toEqual(["b", "a"]);
  });
});
