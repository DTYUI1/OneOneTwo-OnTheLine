import { useState } from "react";
import { STATE_LABELS } from "../../arm/cardModel";
import { criterionLabel, readable } from "../console/model";
import styles from "./Replay.module.css";
import {
  clock,
  frameAt,
  type Moment,
  nextProblem,
  type Timeline,
  type TimelineInput,
} from "./timeline";
import { type Evaluation, useReplay } from "./useReplay";

export interface ReplayProps {
  readonly cardId: string;
}

// Подписи статусов — общие с АРМ, включая этапы v3 «Прибытие» и «Проведение работ».
const STATE_WORD: Record<string, string> = STATE_LABELS;

const CALL_WORD: Record<string, string> = {
  none: "звонка не было",
  dialing: "идёт вызов",
  talking: "разговор",
  ended: "звонок завершён",
};

export function Stage({
  input,
  timeline,
  evaluation,
}: {
  input: TimelineInput;
  timeline: Timeline;
  evaluation: Evaluation | null;
}) {
  const [offsetS, setOffsetS] = useState(0);
  const frame = frameAt(input, timeline, offsetS);
  const back = nextProblem(timeline, offsetS, -1);
  const forward = nextProblem(timeline, offsetS, 1);
  const goTo = (moment: Moment | null) =>
    moment && setOffsetS(Math.round(moment.offsetS));
  // Подсвечиваем ровно один момент — последний, который уже наступил.
  // Сравнение по секунде зажигало бы все события одной секунды сразу,
  // а в быстрых прогонах это весь журнал.
  const currentIndex = timeline.moments.reduce(
    (best, moment, index) => (moment.offsetS <= offsetS ? index : best),
    -1,
  );

  return (
    <section className={styles.replay}>
      <div className={styles.controls}>
        <span className={styles.time}>
          {clock(offsetS)} из {clock(timeline.totalS)}
        </span>
        <button
          type="button"
          className={styles.jump}
          onClick={() => goTo(back)}
          disabled={!back}
        >
          ← предыдущая ошибка
        </button>
        <button
          type="button"
          className={styles.jump}
          onClick={() => goTo(forward)}
          disabled={!forward}
        >
          следующая ошибка →
        </button>
        <span className={styles.label}>
          {timeline.problems.length === 0
            ? "Ошибок не найдено"
            : `Ошибок: ${timeline.problems.length}`}
        </span>
      </div>

      <div className={styles.track}>
        <input
          className={styles.scrubber}
          type="range"
          min={0}
          max={Math.ceil(timeline.totalS)}
          step={1}
          value={offsetS}
          // Подпись прежняя, хотя в v3 отсчёт идёт от направления карточки:
          // по ней ползунок находит e2e капитана (qa/e2e/team-integration.spec.ts).
          aria-label="Время от вручения карточки"
          onChange={(event) => setOffsetS(Number(event.target.value))}
        />
        <div className={styles.marks}>
          {timeline.problems.map((problem, index) => (
            <button
              key={`${problem.atMs}-${index}`}
              type="button"
              className={styles.mark}
              style={{ left: `${(problem.offsetS / timeline.totalS) * 100}%` }}
              title={`${clock(problem.offsetS)} — ${problem.title}`}
              aria-label={`Перейти к ошибке: ${problem.title}`}
              onClick={() => setOffsetS(Math.round(problem.offsetS))}
            />
          ))}
        </div>
      </div>

      <div className={styles.panes}>
        <ul className={styles.log}>
          {timeline.moments.map((moment, index) => (
            <li key={`${moment.atMs}-${index}`}>
              <button
                type="button"
                className={`${moment.kind === "problem" ? styles.problem : ""} ${
                  index === currentIndex ? styles.now : ""
                }`}
                onClick={() => setOffsetS(Math.round(moment.offsetS))}
              >
                <span className={styles.at}>{clock(moment.offsetS)}</span>
                <span className={styles.title}>{moment.title}</span>
                {moment.detail && (
                  <span className={styles.detail}>{moment.detail}</span>
                )}
              </button>
            </li>
          ))}
        </ul>

        <div>
          <div className={styles.card}>
            <h3>Карточка на этой секунде</h3>
            <div className={styles.status}>
              {STATE_WORD[frame.state] ?? frame.state}
            </div>
            <div className={styles.field}>
              <span className={styles.label}>Открыта</span>
              <span>{frame.opened ? "да" : "нет"}</span>
            </div>
            <div className={styles.field}>
              <span className={styles.label}>Номер наряда</span>
              <span>{frame.orderNumber || "—"}</span>
            </div>
            <div className={styles.field}>
              <span className={styles.label}>Комментарий</span>
              <span>{frame.comment || "—"}</span>
            </div>
            <div className={styles.field}>
              <span className={styles.label}>Телефон</span>
              <span>
                {frame.callPhoneExt
                  ? `${frame.callPhoneExt} — ${CALL_WORD[frame.callPhase]}`
                  : CALL_WORD.none}
              </span>
            </div>
            {/* То, что обучаемый к этой секунде услышал от бригад, — по этому
                он и должен был писать комментарий. */}
            {frame.reports.length > 0 && (
              <div className={styles.field}>
                <span className={styles.label}>Доклады бригад</span>
                <ol className={styles.reports}>
                  {frame.reports.map((report, index) => (
                    <li key={index}>{report}</li>
                  ))}
                </ol>
              </div>
            )}
          </div>

          {evaluation && (
            <div className={styles.verdict}>
              <h3>Вердикт</h3>
              <div className={styles.total}>
                {Math.round(evaluation.total * 100)} из 100
              </div>
              <ul className={styles.criteria}>
                {evaluation.criteria.map((criterion) => (
                  <li key={criterion.key} className={styles.criterion}>
                    <span className={criterion.score < 1 ? styles.lost : ""}>
                      {criterionLabel(criterion.key)}
                    </span>
                    <span className={styles.score}>
                      {Math.round(criterion.score * 100)}
                    </span>
                    {criterion.score < 1 && criterion.explanation && (
                      <span className={styles.why}>
                        {readable(criterion.explanation)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {evaluation.teacher_comment && (
                <p>Комментарий преподавателя: {evaluation.teacher_comment}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export function Replay({ cardId }: ReplayProps) {
  const replay = useReplay(cardId);
  if (replay.error) return <p role="alert">{replay.error}</p>;
  if (replay.loading) return <p>Загрузка занятия…</p>;
  if (!replay.input || !replay.timeline)
    return <p className={styles.empty}>По этой карточке журнала нет.</p>;
  return (
    // key сбрасывает позицию скраббера при смене карточки: разбор второй
    // карточки должен начинаться с её начала, а не с секунды предыдущей.
    <Stage
      key={cardId}
      input={replay.input}
      timeline={replay.timeline}
      evaluation={replay.evaluation}
    />
  );
}
