// Графики отчёта (D-02) на чистом SVG. Значения — ровно те, что в отчёте сервера
// и в CSV: график можно сверить с выгрузкой. Одна серия — легенда не нужна,
// заголовок называет величину; каждая полоса подписана и имеет подсказку.
import { formatSeconds, type TraineeLine } from "./reportModel";
import styles from "./Console.module.css";

const ROW = 30;
const BAR = 18;
const LABEL_W = 170;
const PLOT_W = 380;
const VALUE_W = 110;
const WIDTH = LABEL_W + PLOT_W + VALUE_W;

/** Полоса с 4px скруглением на конце данных и прямым краем у базовой линии. */
function barPath(x: number, y: number, w: number, h: number): string {
  if (w <= 0) return "";
  const r = Math.min(4, w, h / 2);
  return `M${x},${y} h${w - r} q${r},0 ${r},${r} v${h - 2 * r} q0,${r} ${-r},${r} h${-(w - r)} z`;
}

function RowLabel({ line, y }: { line: TraineeLine; y: number }) {
  return (
    <text
      x={LABEL_W - 8}
      y={y + ROW / 2 + 4}
      textAnchor="end"
      className={styles.chartText}
    >
      АРМ {line.seat} · {line.fullName}
    </text>
  );
}

export function ScoreChart({ lines }: { lines: TraineeLine[] }) {
  const height = lines.length * ROW + 28;
  const x = (value: number) => LABEL_W + value * PLOT_W;
  return (
    <figure className={styles.chart}>
      <figcaption className={styles.chartTitle}>
        Итоговый балл по местам — эффективная оценка сервера (с учётом решения
        преподавателя)
      </figcaption>
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        role="img"
        aria-label="Итоговый балл по местам"
      >
        {[0, 0.5, 1].map((tick) => (
          <g key={tick}>
            <line
              x1={x(tick)}
              x2={x(tick)}
              y1={0}
              y2={height - 20}
              className={styles.chartGrid}
            />
            <text
              x={x(tick)}
              y={height - 6}
              textAnchor="middle"
              className={styles.chartAxis}
            >
              {Math.round(tick * 100)} %
            </text>
          </g>
        ))}
        {lines.map((line, index) => {
          const y = index * ROW;
          return (
            <g key={line.userId} className={styles.chartRow}>
              <RowLabel line={line} y={y} />
              {line.total === null ? (
                <text
                  x={LABEL_W + 6}
                  y={y + ROW / 2 + 4}
                  className={styles.chartMuted}
                >
                  нет оценки
                </text>
              ) : (
                <>
                  <path
                    d={barPath(
                      LABEL_W,
                      y + (ROW - BAR) / 2,
                      Math.max(1, line.total * PLOT_W),
                      BAR,
                    )}
                    className={styles.chartBar}
                  >
                    <title>
                      АРМ {line.seat} · {line.fullName}:{" "}
                      {Math.round(line.total * 100)} % · оценённых попыток{" "}
                      {line.scoredAttempts}
                    </title>
                  </path>
                  <text
                    x={x(line.total) + 6}
                    y={y + ROW / 2 + 4}
                    className={styles.chartText}
                  >
                    {Math.round(line.total * 100)} %
                  </text>
                </>
              )}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

/**
 * Время против норматива снимка занятия. Реакция и отработка — разные масштабы,
 * поэтому два отдельных графика (не две оси на одном). Превышение — статусным
 * цветом и словом.
 */
export function TimeChart({
  lines,
  pick,
  normative,
  title,
  estimated = () => false,
}: {
  lines: TraineeLine[];
  pick: (line: TraineeLine) => number | null;
  normative: number;
  title: string;
  /** Оценочное значение (часы не подтверждены) — помечаем «≈». */
  estimated?: (line: TraineeLine) => boolean;
}) {
  const values = lines
    .map(pick)
    .filter((value): value is number => value !== null);
  const max = Math.max(normative * 1.25, ...values);
  const height = lines.length * ROW + 28;
  const x = (value: number) => LABEL_W + (value / max) * PLOT_W;
  return (
    <figure className={styles.chart}>
      <figcaption className={styles.chartTitle}>
        {title} — как считает сервер; линия — норматив{" "}
        {formatSeconds(normative)}
      </figcaption>
      <svg viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label={title}>
        <line
          x1={LABEL_W}
          x2={LABEL_W}
          y1={0}
          y2={height - 20}
          className={styles.chartGrid}
        />
        <line
          x1={x(normative)}
          x2={x(normative)}
          y1={0}
          y2={height - 20}
          className={styles.chartNorm}
        />
        <text
          x={x(normative)}
          y={height - 6}
          textAnchor="middle"
          className={styles.chartAxis}
        >
          норматив {formatSeconds(normative)}
        </text>
        {lines.map((line, index) => {
          const y = index * ROW;
          const value = pick(line);
          const over = value !== null && value > normative;
          return (
            <g key={line.userId} className={styles.chartRow}>
              <RowLabel line={line} y={y} />
              {value === null ? (
                <text
                  x={LABEL_W + 6}
                  y={y + ROW / 2 + 4}
                  className={styles.chartMuted}
                >
                  нет данных
                </text>
              ) : (
                <>
                  <path
                    d={barPath(
                      LABEL_W,
                      y + (ROW - BAR) / 2,
                      Math.max(1, x(value) - LABEL_W),
                      BAR,
                    )}
                    className={over ? styles.chartBarOver : styles.chartBar}
                  >
                    <title>
                      АРМ {line.seat} · {line.fullName}: {formatSeconds(value)}
                      {over ? " — норматив превышен" : ""}
                    </title>
                  </path>
                  <text
                    x={x(value) + 6}
                    y={y + ROW / 2 + 4}
                    className={styles.chartText}
                  >
                    {estimated(line) ? "≈ " : ""}
                    {formatSeconds(value)}
                    {over ? " · превышен" : ""}
                  </text>
                </>
              )}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
