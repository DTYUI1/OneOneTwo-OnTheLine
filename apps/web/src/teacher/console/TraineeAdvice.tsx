// Самостоятельная работа обучаемых (GP-14): ступень пути и рекомендации ИИ после
// оценённых карточек — то же, что видит обучаемый в «Мой путь» (GET /progress).
import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api";
import { adviceLines } from "../../arm/progress/progressModel";
import kit from "./Console.module.css";

export function TraineeAdvice() {
  const progress = useQuery({
    queryKey: ["progress"],
    queryFn: async () => (await api.GET("/progress")).data ?? [],
  });
  const trainees = progress.data ?? [];
  if (trainees.length === 0) return null;
  return (
    <section className={kit.panel} aria-labelledby="trainee-advice-title">
      <h3 id="trainee-advice-title" className={kit.panelTitle}>
        Путь обучаемых и рекомендации
      </h3>
      <table className={kit.table}>
        <thead>
          <tr>
            <th>Обучаемый</th>
            <th>Ступень</th>
            <th>Рекомендации</th>
          </tr>
        </thead>
        <tbody>
          {trainees.map((item) => {
            const step = item.steps.find(
              (each) => each.number === item.current_step,
            );
            return (
              <tr key={item.user_id}>
                <td>{item.full_name}</td>
                <td>
                  {item.current_step} из 4{step ? ` · ${step.title}` : ""}
                </td>
                <td>
                  {item.advice ? (
                    adviceLines(item.advice).map((line) => (
                      <div key={line}>{line}</div>
                    ))
                  ) : (
                    <span className={kit.muted}>оценённых карточек нет</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
