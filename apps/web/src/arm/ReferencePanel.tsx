// Справка обучаемого (D-03, FR-1.7): материалы, которые преподаватель назначил на
// занятие (только reference; материалы для оценивания сервер ученику не выдаёт).
// Открывается по отдельному адресу /arm/reference под общей шапкой.
import { useQuery } from "@tanstack/react-query";
import { api } from "../shared/api";
import {
  contentUrl,
  formatSize,
  latestVersions,
  MEDIA_TYPES,
} from "../teacher/materials/materialsModel";
import { WorkflowSteps } from "../shared/WorkflowGuide";
import styles from "./results/Results.module.css";

export function ReferencePanel({ onClose }: { onClose: () => void }) {
  const materials = useQuery({
    queryKey: ["materials"],
    queryFn: async () => {
      const { data, error, response } = await api.GET("/materials");
      if (!data)
        throw new Error(
          response.status === 501
            ? "Справочная база на сервере ещё не подключена."
            : (error?.message ?? "Справка недоступна."),
        );
      return data;
    },
  });
  const list = latestVersions(materials.data ?? []);

  return (
    <section className={styles.panel} aria-labelledby="reference-title">
      <header className={styles.head} data-help="reference-heading">
        <h2 id="reference-title">Справка</h2>
        <p className={styles.counters}>
          материалы, назначенные преподавателем на ваши занятия
        </p>
        <button
          type="button"
          className={styles.close}
          onClick={onClose}
          aria-label="Закрыть справку"
        >
          ✕
        </button>
      </header>
      {materials.isPending && (
        <p className={styles.empty}>Загружаем справку…</p>
      )}
      {materials.isError && (
        <p role="alert" className={styles.empty}>
          {materials.error.message}
        </p>
      )}
      {/* Без материалов преподавателя справка не тупик: порядок работы с
          карточкой — тот же список, что в «Порядке работы» шапки. */}
      {materials.data && list.length === 0 && (
        <p className={styles.empty}>
          Преподаватель пока не назначил справочных материалов. Ниже — порядок
          работы с карточкой.
        </p>
      )}
      {(materials.isError || (materials.data && list.length === 0)) && (
        <WorkflowSteps />
      )}
      {list.length > 0 && (
        <ul className={styles.referenceList} data-help="reference-materials">
          {list.map((item) => (
            <li key={item.id}>
              <a href={contentUrl(item)} target="_blank" rel="noreferrer">
                {item.title}
              </a>
              <span className={styles.muted}>
                {MEDIA_TYPES[item.media_type]?.label ?? item.media_type} ·{" "}
                {formatSize(item.size_bytes)} · версия {item.version}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
