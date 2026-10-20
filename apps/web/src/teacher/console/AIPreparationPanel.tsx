import { StopGenerationButton } from "../../shared/StopGenerationButton";
import type { components } from "../../api-client/schema";
import { GenerationProgress } from "../../shared/GenerationProgress";
import { useUsers } from "./useConsoleData";
import styles from "./Console.module.css";

type Preparation = components["schemas"]["AIPreparation"];

export function AIPreparationPanel({
  preparation,
}: {
  preparation: Preparation;
}) {
  const users = useUsers();
  return (
    <div className={styles.panel}>
      <h3 className={styles.panelTitle}>ИИ подбирает задания</h3>
      <GenerationProgress
        state={preparation.state}
        completed={preparation.completed}
        total={preparation.total}
      />
      {["waiting", "queued", "generating", "stopping"].includes(
        preparation.state,
      ) && (
        <StopGenerationButton
          jobId={preparation.job_id}
          stopping={preparation.state === "stopping"}
        />
      )}
      {preparation.state === "cancelled" && (
        <p role="status">
          Остановлено: готово {preparation.completed} из {preparation.total}.
          Сценарии сохранены в пакете черновиками.
        </p>
      )}
      {["waiting", "queued", "generating"].includes(preparation.state) && (
        <p className={styles.hint}>
          Подготовка идёт до начала занятия. Нормативы обучаемых ещё не идут.
        </p>
      )}
      {preparation.state === "ready" && (
        <p>Весь набор проверен и назначен. Можно начать занятие.</p>
      )}
      {preparation.warnings.map((warning) => (
        <p key={warning} role="alert">
          {warning}
        </p>
      ))}
      <ul>
        {preparation.recommendations.map((item) => (
          <li key={item.user_id}>
            {users.data?.find((user) => user.id === item.user_id)?.full_name ??
              "Обучаемый"}
            : уровень {item.level}. {item.explanation}
          </li>
        ))}
      </ul>
    </div>
  );
}
