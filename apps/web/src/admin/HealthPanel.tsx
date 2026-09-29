// Состояние системы — GET /admin/health (сводка) и GET /admin/status (компоненты, нагрузка,
// место, копии, оповещения — C-07), словами и с автообновлением.
import { useQuery } from "@tanstack/react-query";
import { api } from "../shared/api";
import { describeHealth, describeStatus } from "./adminModel";
import { useSystemStatus } from "./useSystemStatus";
import kit from "../teacher/console/Console.module.css";
import styles from "./Admin.module.css";

export function HealthPanel() {
  const health = useQuery({
    queryKey: ["admin-health"],
    queryFn: async () => {
      const { data, error } = await api.GET("/admin/health");
      if (!data) throw new Error(error?.message ?? "Сервер не ответил.");
      return data;
    },
    refetchInterval: 15_000,
  });
  const status = useSystemStatus();

  return (
    <div className={kit.tabBody}>
      {health.isPending && (
        <p className={kit.placeholder}>Опрашиваем сервер…</p>
      )}
      {health.isError && (
        <p role="alert" className={kit.placeholder}>
          Сервер не ответил: {health.error.message}. Остальные разделы тоже
          могут не работать.
        </p>
      )}
      {health.data && (
        <div className={styles.healthGrid}>
          {describeHealth(health.data).map((item) => (
            <div key={item.label} className={styles[`tile_${item.tone}`]}>
              <span className={styles.tileLabel}>{item.label}</span>
              <strong className={styles.tileValue}>{item.value}</strong>
              <span className={styles.tileHint}>{item.hint}</span>
            </div>
          ))}
        </div>
      )}
      {status.data && status.data.alerts.length > 0 && (
        <ul className={kit.problems} role="status" aria-label="Оповещения">
          {status.data.alerts.map((alert) => (
            <li key={alert.message}>
              {alert.level === "error" ? "Сбой: " : "Внимание: "}
              {alert.message}
            </li>
          ))}
        </ul>
      )}
      {status.data && (
        <div className={styles.healthGrid} aria-label="Компоненты и нагрузка">
          {describeStatus(status.data, status.dataUpdatedAt).map((item) => (
            <div key={item.label} className={styles[`tile_${item.tone}`]}>
              <span className={styles.tileLabel}>{item.label}</span>
              <strong className={styles.tileValue}>{item.value}</strong>
              <span className={styles.tileHint}>{item.hint}</span>
            </div>
          ))}
        </div>
      )}
      {status.isError && (
        <p role="alert" className={kit.placeholder}>
          Подробное состояние недоступно: {status.error.message}
        </p>
      )}
      <div className={kit.actions}>
        <button
          type="button"
          className={kit.plain}
          disabled={health.isFetching || status.isFetching}
          onClick={() => {
            void health.refetch();
            void status.refetch();
          }}
        >
          {health.isFetching ? "Проверяем…" : "Проверить сейчас"}
        </button>
        {health.dataUpdatedAt > 0 && (
          <span className={kit.hint}>
            Проверено в{" "}
            {new Date(health.dataUpdatedAt).toLocaleTimeString("ru-RU")},
            обновляется каждые 15 с.
          </span>
        )}
      </div>
    </div>
  );
}
