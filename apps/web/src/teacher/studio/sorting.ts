export type SortState<K extends string = string> = {
  key: K;
  direction: "asc" | "desc";
};
export const NEWEST_FIRST = { key: "created_at", direction: "desc" } as const;

export function nextSort<K extends string>(
  current: SortState<K>,
  key: K,
): SortState<K> {
  return {
    key,
    direction:
      current.key === key && current.direction === "asc" ? "desc" : "asc",
  };
}

const collator = new Intl.Collator("ru", {
  numeric: true,
  sensitivity: "base",
});
/** Пустые значения в конце при любом направлении; исходный массив не меняем. */
export function sortedRows<T, K extends string>(
  rows: readonly T[],
  sort: SortState<K>,
  value: (row: T, key: K) => string | number | null | undefined,
): T[] {
  return [...rows].sort((a, b) => {
    const av = value(a, sort.key),
      bv = value(b, sort.key);
    if (av == null || av === "") return bv == null || bv === "" ? 0 : 1;
    if (bv == null || bv === "") return -1;
    const result =
      typeof av === "number" && typeof bv === "number"
        ? av - bv
        : collator.compare(String(av), String(bv));
    return sort.direction === "asc" ? result : -result;
  });
}
export function creationTime(value?: string | null): number | null {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? timestamp : null;
}
export function creationDate(value?: string | null): string {
  return value && creationTime(value) !== null
    ? new Date(value).toLocaleString("ru-RU", {
        dateStyle: "short",
        timeStyle: "short",
      })
    : "—";
}
