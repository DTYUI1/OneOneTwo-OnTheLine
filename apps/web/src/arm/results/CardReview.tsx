// Разбор одной карточки для обучаемого: оценка, слово преподавателя и факты
// против правил. Баллы — с сервера; здесь только показываем и сравниваем с нормативом.
import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api";
import {
  criterionLabel,
  evaluationNote,
  formatScore,
  hasScore,
  readable,
  weakestFirst,
} from "../../teacher/console/model";
import { formatDuration, STATE_LABELS, type Service } from "../cardModel";
import { useParticipant } from "../useParticipant";
import {
  formatPath,
  fullCycle,
  practiceStepOf,
  REGULATION_TEXT,
  statusPath,
  type ResultRow,
} from "./resultsModel";
import { useAttemptAnalysis } from "../useAnalysis";
import { PracticeButton } from "../practice/PracticeButton";
import {
  afterAction,
  attemptTimeline,
  attemptVerdict,
  buildDebrief,
  criterionLevel,
  focusFor,
  LEVEL_LABELS,
  notApplicable,
  notApplicableLabels,
  traineeEvidence,
} from "./debrief";
import { remaining } from "../progress/progressModel";
import { BRIGADE_ANSWER_S, lateAnswers } from "../callbacks";
import { trainingQuery } from "../softphone/brigade/data";
import { QUALITY_LABELS, timeRows } from "../timeRows";
import styles from "./Results.module.css";

export function CardReview({
  row,
  services,
}: {
  row: ResultRow;
  services: Service[];
}) {
  const { card, evaluation } = row;
  // Бригада звонила с докладом — сколько ждала ответа (только показ, без балла).
  const training = useQuery({ ...trainingQuery(card.id), retry: false });
  const late = lateAnswers(
    training.data?.callbacks ?? [],
    Date.parse(card.closed_at ?? card.interrupted_at ?? "") || Date.now(),
  );
  const events = useQuery({
    queryKey: ["card-events", card.id],
    queryFn: async ({ signal }) => {
      const { data } = await api.GET("/cards/{id}/events", {
        params: { path: { id: card.id } },
        signal,
      });
      return data ?? [];
    },
  });
  const context = useParticipant(card.session_id, card.trainee_id);
  const serviceName = (id: string) =>
    services.find((service) => service.id === id)?.name ?? id;

  // Время, решение преподавателя и итог — из серверного разбора попытки.
  const analysis = useAttemptAnalysis(card.id);
  const timing = analysis.data?.timing ?? null;
  const override = analysis.data?.evaluation?.effective_override ?? null;
  const path = statusPath(events.data ?? []);
  const addressed = card.source.service_ids ?? [];
  const own = context.participant?.dds_service_id ?? null;
  const scored = evaluation ? hasScore(evaluation) : false;
  // «Предварительная оценка…» пугает: для обучаемого это просто «оценка уточняется».
  const rawNote = evaluation ? evaluationNote(evaluation) : null;
  const note = rawNote?.startsWith("Предварительная") ? null : rawNote;
  const criteria = evaluation ? weakestFirst(evaluation) : [];
  const debrief = scored ? buildDebrief(criteria) : null;
  const teacherTotal =
    override?.decision === "disagree" ? override.new_total : null;
  const verdict =
    scored && evaluation
      ? attemptVerdict(
          analysis.data?.evaluation?.effective_total ?? evaluation.total,
          criteria,
          teacherTotal,
        )
      : null;
  const review = scored
    ? afterAction({
        criteria,
        times: timing ? timeRows(timing) : [],
        path: events.isPending ? "" : formatPath(path),
        comment: card.current.comment,
        teacherComment:
          override?.teacher_comment || evaluation?.teacher_comment || "",
      })
    : null;
  // Тренировку можно пройти снова сразу из разбора; занятие преподавателя — нет.
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: async () => (await api.GET("/sessions")).data ?? [],
  });
  const session = sessions.data?.find((item) => item.id === card.session_id);
  const practice = session?.kind === "practice";
  // Повтор — той же ступени, что и эта тренировка, а не упражнения ступени 1.
  const step = session ? practiceStepOf(session) : undefined;
  // Где обучаемый на пути: та же выборка, что в «Мой путь».
  const progress = useQuery({
    queryKey: ["progress"],
    queryFn: async () => {
      const { data, error } = await api.GET("/progress");
      if (!data) throw new Error(error?.message ?? "Путь недоступен.");
      return data[0] ?? null;
    },
    retry: false,
  });
  const pathStep = progress.data?.steps.find(
    (item) => item.number === (step ?? progress.data?.current_step),
  );
  const focus = debrief ? focusFor(debrief) : undefined;
  const skipped = scored ? notApplicableLabels(criteria) : "";
  const timeline = attemptTimeline(
    events.data ?? [],
    card.delivered_at ?? card.appeared_at,
    timing
      ? {
          reactionOver: timing.reaction_overdue === true,
          handlingOver: timing.handling_overdue === true,
        }
      : null,
  );

  return (
    <article
      className={styles.review}
      aria-labelledby="review-title"
      data-help="results-review"
    >
      <header className={styles.reviewBar}>
        <h3 id="review-title">
          Происшествие {card.source.number} · {card.source.incident_class}
        </h3>
        <span className={styles.chip}>{STATE_LABELS[card.state]}</span>
      </header>

      <section className={styles.block}>
        <h4>Оценка</h4>
        {!evaluation && (
          <p className={styles.muted}>
            {row.interrupted
              ? "Оценки нет: карточка не была закрыта до завершения занятия."
              : "Разбор готовится: оценщик получает карточку после закрытия. Экран обновится сам."}
          </p>
        )}
        {evaluation && !verdict && (
          <p className={styles.scoreNone}>без оценки</p>
        )}
        {verdict && evaluation && (
          <>
            <div className={styles.verdictRow}>
              <p
                className={verdict.passed ? styles.passed : styles.failed}
                role="status"
              >
                <strong>{verdict.label}</strong> ·{" "}
                <span className={styles.percent}>
                  {formatScore(
                    analysis.data?.evaluation?.effective_total ??
                      evaluation.total,
                  )}
                </span>
                {evaluation.status !== "complete" && (
                  <span className={styles.pending}> · оценка уточняется</span>
                )}
              </p>
              {practice && (
                <PracticeButton label="Пройти тренировку ещё раз" step={step} />
              )}
            </div>
            <p className={styles.muted}>{verdict.detail}</p>
            {focus && (
              <p className={styles.focus}>
                <strong>Главное на следующую попытку:</strong> {focus.title}.{" "}
                {focus.advice}
              </p>
            )}
          </>
        )}
        {pathStep && (
          <p className={styles.hint}>
            Мой путь: ступень {pathStep.number}. {pathStep.title} —{" "}
            {remaining(pathStep)}
          </p>
        )}
        {note && <p className={styles.note}>{note}</p>}
      </section>

      {(override || evaluation?.teacher_comment.trim()) && (
        <section className={styles.block}>
          <h4>Решение преподавателя</h4>
          {override && (
            <p className={styles.muted}>
              {override.decision === "agree"
                ? "Преподаватель согласился с оценкой."
                : `Преподаватель изменил оценку${
                    override.new_total === null
                      ? ""
                      : ` на ${formatScore(override.new_total)}`
                  }.`}
            </p>
          )}
          {(
            override?.teacher_comment || evaluation?.teacher_comment
          )?.trim() && (
            <blockquote className={styles.comment}>
              {override?.teacher_comment || evaluation?.teacher_comment}
            </blockquote>
          )}
        </section>
      )}

      {debrief && review && (
        <section className={styles.block} aria-labelledby="debrief-title">
          <h4 id="debrief-title">Итоги</h4>
          {/* Разбор по четырём вопросам (After Action Review): главное — первым. */}
          <dl className={styles.aar}>
            <dt>Что сделать иначе</dt>
            <dd>
              {debrief.improve.length === 0 ? (
                <p>Замечаний нет: попытка выполнена по правилам.</p>
              ) : (
                <ol className={styles.improve}>
                  {debrief.improve.map((item) => (
                    <li key={item.key}>
                      <strong>{item.title}</strong>{" "}
                      <span className={styles.level} data-level={item.level}>
                        {item.critical
                          ? "критическая ошибка"
                          : LEVEL_LABELS[item.level]}
                      </span>
                      <p>{item.advice}</p>
                      {item.fact && <p className={styles.muted}>{item.fact}</p>}
                    </li>
                  ))}
                </ol>
              )}
            </dd>
            <dt>Что ожидалось</dt>
            <dd>
              <ul>
                {review.expected.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </dd>
            <dt>Что сделано</dt>
            <dd>
              <ul>
                {review.done.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </dd>
            {review.why && (
              <>
                <dt>Почему так вышло</dt>
                <dd>{review.why}</dd>
              </>
            )}
          </dl>
          {debrief.good.length > 0 && (
            <p>
              <span className={styles.ok}>Получилось:</span>{" "}
              {debrief.good.join(", ")}.
            </p>
          )}
          {skipped && (
            <p className={styles.hint}>
              В этом сценарии не требуется: {skipped}.
            </p>
          )}
          {timeline.length > 0 && (
            <details className={styles.more}>
              <summary>Хронология</summary>
              <ol className={styles.timeline}>
                {timeline.map((line, index) => (
                  <li
                    key={`${line.at}-${index}`}
                    className={line.over ? styles.bad : undefined}
                  >
                    <span className={styles.at}>{formatDuration(line.at)}</span>{" "}
                    {line.label}
                    {line.over && " — позже норматива"}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </section>
      )}

      <section className={styles.block}>
        <h4>Что проверяется правилами</h4>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Показатель</th>
              <th>У вас</th>
              <th>По правилам</th>
              <th>Итог</th>
            </tr>
          </thead>
          <tbody>
            {analysis.isPending && (
              <tr>
                <td colSpan={4} className={styles.muted}>
                  Загружаем время попытки…
                </td>
              </tr>
            )}
            {timing &&
              timeRows(timing).map((line) => (
                <tr key={line.label}>
                  <td>{line.label}</td>
                  <td>
                    {line.seconds === null
                      ? "—"
                      : formatDuration(Math.round(line.seconds))}
                  </td>
                  <td>
                    {line.normative === null
                      ? ""
                      : `не дольше ${formatDuration(line.normative)}`}
                  </td>
                  <td>
                    {line.verdict === "unknown" ? (
                      <span className={styles.muted}>нет данных</span>
                    ) : line.verdict === "info" ? null : (
                      <Verdict
                        ok={line.verdict === "ok"}
                        good="в нормативе"
                        bad={`дольше на ${formatDuration(Math.round((line.seconds ?? 0) - (line.normative ?? 0)))}`}
                      />
                    )}
                  </td>
                </tr>
              ))}
            <tr>
              <td>Статусы</td>
              <td>{events.isPending ? "загружаем…" : formatPath(path)}</td>
              <td>{REGULATION_TEXT}</td>
              <td>
                {!events.isPending && (
                  <Verdict
                    ok={fullCycle(path)}
                    good="принята и завершена"
                    bad="цикл не пройден до конца"
                  />
                )}
              </td>
            </tr>
            <tr>
              <td>Служба</td>
              <td>{own ? serviceName(own) : "—"}</td>
              <td>
                {addressed.length
                  ? addressed.map(serviceName).join(", ")
                  : "не указана"}
              </td>
              <td>
                {own && addressed.length > 0 && (
                  <Verdict
                    ok={addressed.includes(own)}
                    good="карточка вашей службы"
                    bad="карточка другой службы"
                  />
                )}
              </td>
            </tr>
          </tbody>
        </table>
        <p className={styles.hint}>
          Время — по методике занятия
          {timing
            ? ` (версия ${timing.timing_version}; ${QUALITY_LABELS[timing.quality]})`
            : ""}
          . Нормативы — из снимка занятия.
        </p>
        {(row.interrupted ||
          analysis.data?.attempt_status === "interrupted") && (
          <p className={styles.hint} role="note">
            <strong>
              Попытка прервана: занятие завершилось раньше, чем карточка была
              закрыта.
            </strong>
          </p>
        )}
        {late.map((wait) => (
          <p key={wait.callId} className={styles.hint} role="note">
            Бригада звонила с докладом и{" "}
            {wait.answered
              ? `ждала ответа ${formatDuration(wait.waitS)}`
              : `не дождалась ответа (${formatDuration(wait.waitS)})`}
            . Ориентир — ответить за {formatDuration(BRIGADE_ANSWER_S)}: пока
            доклад не услышан, карточку не продвинуть.
          </p>
        ))}
      </section>

      <section className={styles.block}>
        <h4>Разбор по критериям</h4>
        {criteria.length === 0 ? (
          <p className={styles.muted}>
            Оценщик пока не вернул разбора по критериям.
          </p>
        ) : debrief ? (
          // Главное уже в «Итогах»: полный список — по запросу, для самопроверки.
          <details className={styles.more}>
            <summary>Все критерии</summary>
            <CriteriaList criteria={criteria} scored={scored} />
          </details>
        ) : (
          <CriteriaList criteria={criteria} scored={scored} />
        )}
      </section>
    </article>
  );
}

function Verdict({
  ok,
  good,
  bad,
}: {
  ok: boolean;
  good: string;
  bad: string;
}) {
  // Цвет дублируется словом: итог читается и без различения цветов.
  return <span className={ok ? styles.ok : styles.bad}>{ok ? good : bad}</span>;
}

function CriteriaList({
  criteria,
  scored,
}: {
  criteria: ReturnType<typeof weakestFirst>;
  scored: boolean;
}) {
  return (
    <ul className={styles.criteria}>
      {criteria.map((criterion) => {
        const evidence = traineeEvidence(criterion.evidence);
        return (
          <li
            key={criterion.key}
            className={criterion.critical ? styles.critical : undefined}
          >
            <div className={styles.criterionHead}>
              <strong>{criterionLabel(criterion.key)}</strong>
              <span>
                {!scored
                  ? "—"
                  : notApplicable(criterion)
                    ? "не требуется"
                    : `${LEVEL_LABELS[criterionLevel(criterion.score)]} · ${formatScore(criterion.score)}`}
              </span>
            </div>
            <p>{readable(criterion.explanation)}</p>
            {evidence.length > 0 && (
              <ul className={styles.evidence}>
                {evidence.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}
