import { useEffect, useRef, useState } from "react";
import {
  GENERATION_LABELS,
  formatLeft,
  generationActive,
  secondsLeft,
  generationPercent,
  type GenerationState,
  type ProgressMark,
} from "./aiProgress";
import styles from "./GenerationProgress.module.css";

/**
 * Полоса хода генерации: N из M, что сейчас делается и сколько ждать. Время считается по
 * скорости текущего запуска, до первого результата — по замеру сервера.
 */
export function GenerationProgress({
  state,
  completed,
  total,
  expectedSeconds,
}: {
  state: GenerationState;
  completed: number;
  total: number;
  expectedSeconds?: number | null;
}) {
  const active = generationActive(state);
  const start = useRef<ProgressMark | null>(null);
  const last = useRef<ProgressMark | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Отсчёт — с первого «Генерируется»: ожидание конца занятия в скорость не входит.
  if (state === "generating" && start.current === null)
    start.current = { at: Date.now(), completed };
  if (start.current && completed !== last.current?.completed)
    last.current = { at: Date.now(), completed };

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  const percent =
    state === "generating" && start.current && last.current
      ? generationPercent(
          start.current,
          last.current,
          total,
          now,
          expectedSeconds,
        )
      : total > 0
        ? Math.round((completed / total) * 100)
        : 0;
  const left =
    state === "generating" && start.current && last.current
      ? secondsLeft(start.current, last.current, total, now, expectedSeconds)
      : null;
  return (
    <div className={styles.progress}>
      <div className={styles.head}>
        <span role="status">
          {GENERATION_LABELS[state]} · {completed} из {total}
        </span>
        {state === "generating" && (
          <span className={styles.left}>{formatLeft(left)}</span>
        )}
      </div>
      <div
        className={[
          styles.track,
          state === "generating" ? styles.running : "",
          state === "waiting" || state === "queued" ? styles.idle : "",
          state === "failed" ? styles.failed : "",
        ].join(" ")}
        role="progressbar"
        aria-label="Ход генерации"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={completed}
      >
        <div className={styles.fill} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
