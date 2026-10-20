import { nextSort, type SortState } from "./sorting";
import styles from "./Studio.module.css";

export function SortHeading({
  label,
  field,
  sort,
  onSort,
}: {
  label: string;
  field: string;
  sort: SortState;
  onSort: (sort: SortState) => void;
}) {
  const active = sort.key === field;
  return (
    <th
      scope="col"
      aria-sort={
        active
          ? sort.direction === "asc"
            ? "ascending"
            : "descending"
          : "none"
      }
    >
      <button
        type="button"
        className={styles.sortHeading}
        onClick={() => onSort(nextSort(sort, field))}
      >
        {label}{" "}
        <span aria-hidden="true">
          {active ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
}
