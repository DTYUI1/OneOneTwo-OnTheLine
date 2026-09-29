// Отчёт по занятию (D-02): попытки по стадиям, графики балла и времени,
// причины отличий по каждому месту, типичные ошибки группы, прогноз против
// факта и разбор человека. Цифры — из ответов сервера (те же, что в CSV);
// браузер не пересчитывает баллы и время (ответ капитана §2).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api";
import {
  criterionLabel,
  formatScore,
  hasScore,
  readable,
  verdictsForSession,
  weakestFirst,
  type Session,
} from "./model";
import {
  attemptCounts,
  formatShare,
  normShares,
  forecastLines,
  linesFromAnalytics,
  formatSeconds,
  recommend,
  traineeLines,
  typicalErrors,
  type TraineeLine,
} from "./reportModel";
import { ScoreChart, TimeChart } from "./ReportCharts";
import {
  attemptOwner,
  finishSummary,
  DIRECTION_LABELS,
  LAYER_LABELS,
  LAYER_STATUS_LABELS,
  type AttemptAnalysis,
  type SessionAnalytics,
} from "./analyticsModel";
import { QUALITY_LABELS, timeRows } from "../../arm/timeRows";
import {
  useCards,
  useEvaluations,
  useIssuedAssignments,
  useUsers,
} from "./useConsoleData";
import { ScenarioSource } from "../studio/ScenarioSource";
import styles from "./Console.module.css";

export interface LessonPrefill {
  userId: string;
  level: number;
}

const RECOMMEND_TEXT = {
  up: "повысить до",
  keep: "оставить",
  down: "понизить до",
} as const;

function delta(value: number | null): string {
  if (value === null) return "";
  if (Math.abs(value) < 0.5) return " (в нормативе)";
  return value > 0
    ? ` (+${formatSeconds(value)} к нормативу)`
    : ` (${formatSeconds(value)} от норматива)`;
}

function timeCell(
  seconds: number | null,
  deltaS: number | null,
  estimated?: boolean,
  values?: number[],
): string {
  if (seconds === null)
    return values && values.length > 1
      ? `≈ ${values.map(formatSeconds).join(", ")} (попытки)`
      : "—";
  return `${estimated ? "≈ " : ""}${formatSeconds(seconds)}${delta(deltaS)}`;
}

export function ReportTab({
  session,
  onNewLesson,
}: {
  session: Session;
  onNewLesson?: (prefill: LessonPrefill) => void;
}) {
  const report = useQuery({
    queryKey: ["report", session.id],
    enabled: session.status !== "draft",
    queryFn: async () => {
      const { data } = await api.GET("/reports/session/{id}", {
        params: { path: { id: session.id } },
      });
      return data ?? null;
    },
  });
  // Аналитика C-06: время по методике занятия, слои оценки, ошибки по категориям.
  // Нет её (старый сервер, 501) — отчёт строится по прежнему источнику.
  const analytics = useQuery({
    queryKey: ["analytics", session.id],
    enabled: session.status !== "draft",
    queryFn: async (): Promise<SessionAnalytics | null> => {
      const { data } = await api.GET("/reports/session/{id}/analytics", {
        params: { path: { id: session.id } },
      });
      return data ?? null;
    },
  });
  // Итог завершения: прерванные попытки и отменённые выдачи (C-03).
  const lifecycle = useQuery({
    queryKey: ["lifecycle", session.id],
    enabled: session.status === "finished",
    queryFn: async () => {
      const { data } = await api.GET("/sessions/{id}/lifecycle", {
        params: { path: { id: session.id } },
      });
      return data ?? null;
    },
  });
  const evaluations = useEvaluations();
  // Ступень обучения каждого обучаемого (GET /progress): подсказка к выбору уровня.
  const progress = useQuery({
    queryKey: ["progress"],
    queryFn: async () => (await api.GET("/progress")).data ?? [],
  });
  const stepOf = (userId: string) =>
    progress.data?.find((item) => item.user_id === userId);
  const cards = useCards();
  const users = useUsers();
  const issued = useIssuedAssignments(session.id);
  const [openUser, setOpenUser] = useState<string | null>(null);

  if (session.status === "draft")
    return (
      <p className={styles.placeholder}>Отчёт появится после старта занятия.</p>
    );
  if (report.isPending || evaluations.isPending || cards.isPending)
    return <p className={styles.placeholder}>Собираем отчёт…</p>;
  if (!report.data)
    return (
      <p role="alert" className={styles.placeholder}>
        Отчёт не загрузился.{" "}
        <button
          type="button"
          className={styles.plain}
          onClick={() => void report.refetch()}
        >
          Повторить
        </button>
      </p>
    );

  const fullName = (id: string) =>
    users.data?.find((user) => user.id === id)?.full_name ?? "…";
  const sessionCards = (cards.data ?? []).filter(
    (card) => card.session_id === session.id,
  );
  const rows = verdictsForSession(
    evaluations.data ?? [],
    cards.data ?? [],
    session.id,
  );
  const sessionEvaluations = rows.map((row) => row.evaluation);
  const counts = attemptCounts(
    issued.data.length,
    sessionCards,
    sessionEvaluations,
  );
  const attempts = analytics.data?.attempts ?? [];
  // Нормативы и версия — из результатов времени попыток (снимок занятия), иначе из
  // settings_snapshot: глобальные /settings в разбор не подмешиваются.
  const firstTiming = attempts[0]?.timing;
  const normatives = {
    reaction:
      firstTiming?.reaction_normative_s ??
      session.settings_snapshot.reaction_normative_s,
    handling:
      firstTiming?.handling_normative_s ??
      session.settings_snapshot.handling_normative_s,
  };
  const version = firstTiming?.timing_version ?? null;
  const ownerOf = attemptOwner(sessionCards);
  const lines = analytics.data
    ? linesFromAnalytics(
        session,
        analytics.data,
        sessionEvaluations,
        fullName,
        normatives,
        ownerOf,
      )
    : traineeLines(session, report.data, sessionEvaluations, fullName);
  const errors = typicalErrors(sessionEvaluations);
  const teacherTotals = new Map(
    attempts.flatMap((item) => {
      const decided = item.evaluation?.effective_override;
      return decided?.decision === "disagree" && decided.new_total !== null
        ? [[item.card_id, decided.new_total] as const]
        : [];
    }),
  );
  const shares = normShares(sessionEvaluations, teacherTotals);
  const cardById = new Map(sessionCards.map((card) => [card.id, card]));
  const forecasts = forecastLines(
    report.data.predictions,
    new Set(cardById.keys()),
  );
  const scenarioByAssignment = new Map(
    issued.data.map((item) => [item.id, item.scenario_id]),
  );
  const scenarioOf = (cardId: string) => {
    const card = cardById.get(cardId);
    return card ? scenarioByAssignment.get(card.assignment_id) : undefined;
  };
  const finish = lifecycle.data
    ? finishSummary(lifecycle.data, sessionCards)
    : null;
  const opened = lines.find((line) => line.userId === openUser) ?? null;

  return (
    <div className={styles.tabBody}>
      <div className={styles.panel}>
        <h3 className={styles.panelTitle}>Попытки</h3>
        <div className={styles.tiles}>
          {(
            [
              ["выдано заданий", counts.assigned],
              ["карточек пришло", counts.appeared],
              ["закрыто", counts.closed],
              ["оценено", counts.scored],
              ["закрыто без оценки", counts.unscored],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className={styles.tile}>
              <span className={styles.tileValue}>{value}</span>
              <span className={styles.tileLabel}>{label}</span>
            </div>
          ))}
        </div>
        {/* Нормы как доля карточек (NFPA 1225 / NENA), а не только штраф отдельной. */}
        <div className={styles.tiles}>
          {(
            [
              [`приняты за ${normatives.reaction} с`, shares.reaction],
              [
                `обработаны за ${Math.round(normatives.handling / 60)} мин`,
                shares.handling,
              ],
              ["зачтено", shares.passed],
            ] as const
          ).map(([label, share]) => (
            <div key={label} className={styles.tile}>
              <span className={styles.tileValue}>{formatShare(share)}</span>
              <span className={styles.tileLabel}>
                {label} · {share.ok} из {share.total}
              </span>
            </div>
          ))}
        </div>
        {finish && (finish.interrupted.length > 0 || finish.cancelled > 0) && (
          <div className={styles.note}>
            При завершении занятия
            {finish.cancelled > 0 &&
              ` отменено заданий до выдачи: ${finish.cancelled}`}
            {finish.cancelled > 0 && finish.interrupted.length > 0 && ";"}
            {finish.interrupted.length > 0 &&
              ` прервано незакрытых попыток: ${finish.interrupted.length}`}
            .
            {finish.interrupted.length > 0 && (
              <ul className={styles.criteriaList}>
                {finish.interrupted.map((item) => {
                  const card = cardById.get(item.cardId);
                  return (
                    <li key={item.cardId}>
                      {fullName(item.traineeId)} —{" "}
                      {card
                        ? `происшествие ${card.source.number}`
                        : `карточка ${item.cardId.slice(0, 8)}`}
                      {item.at &&
                        `, прервана в ${new Date(item.at).toLocaleTimeString("ru-RU")}`}
                      , {item.recording}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
        {counts.partial > 0 && (
          <p className={styles.note}>
            {counts.partial} из {counts.scored} оценок — предварительные:
            правила посчитаны, а оценка свободного текста ИИ не выполнялась.
            Балл по правилам действителен, текст доклада не оценён.
          </p>
        )}
        <p className={styles.hint}>
          Балл места — среди его оценённых попыток; «нет оценки» не равно нулю.
          Цифры графиков и таблицы совпадают с «Отчёт CSV».
        </p>
      </div>

      <div className={`${styles.panel} ${styles.charts}`}>
        <ScoreChart lines={lines} />
        <TimeChart
          lines={lines}
          pick={(line) => line.reactionS}
          estimated={(line) => Boolean(line.reactionEstimated)}
          normative={normatives.reaction}
          title={
            version === 3
              ? "Реакция — от направления до «Принята / Не принята»"
              : "Реакция"
          }
        />
        <TimeChart
          lines={lines}
          pick={(line) => line.handlingS}
          estimated={(line) => Boolean(line.handlingEstimated)}
          normative={normatives.handling}
          title={
            version === 3
              ? "Активная отработка — без подтверждённого ожидания"
              : "Отработка"
          }
        />
        {version !== null && (
          <p className={styles.hint}>
            Время — по методике занятия, версия {version}. «≈» — оценочное
            значение попытки: часы устройства не подтверждены, среднее сервер
            считает только по достоверным измерениям.
          </p>
        )}
      </div>

      <div className={styles.panel}>
        <h3 className={styles.panelTitle}>Причины отличий</h3>
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>АРМ</th>
                <th>Обучаемый</th>
                <th>Ур.</th>
                <th>Ступень</th>
                <th>Балл</th>
                <th>Реакция</th>
                <th>Отработка</th>
                <th>Ошибки</th>
                <th>Где просел</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.userId}>
                  <td className={styles.seat}>{line.seat}</td>
                  <td>
                    <button
                      type="button"
                      className={styles.link}
                      aria-expanded={openUser === line.userId}
                      onClick={() =>
                        setOpenUser(
                          openUser === line.userId ? null : line.userId,
                        )
                      }
                    >
                      {line.fullName}
                    </button>
                  </td>
                  <td>{line.level}</td>
                  <td>
                    {(() => {
                      const own = stepOf(line.userId);
                      const step = own?.steps.find(
                        (item) => item.number === own.current_step,
                      );
                      return step ? (
                        <span title={step.skill}>
                          {step.number} из 4 · {step.title}
                        </span>
                      ) : (
                        <span className={styles.muted}>—</span>
                      );
                    })()}
                  </td>
                  <td>
                    {line.total === null ? (
                      <span className={styles.muted}>нет оценки</span>
                    ) : (
                      <strong>{formatScore(line.total)}</strong>
                    )}
                  </td>
                  <td>
                    {timeCell(
                      line.reactionS,
                      line.reactionDeltaS,
                      line.reactionEstimated,
                      line.reactionValues,
                    )}
                  </td>
                  <td>
                    {timeCell(
                      line.handlingS,
                      line.handlingDeltaS,
                      line.handlingEstimated,
                      line.handlingValues,
                    )}
                  </td>
                  <td>
                    {line.errorsText
                      ? line.errorsText.join(", ") ||
                        (line.total === null ? "—" : "нет")
                      : (line.errors ?? "—")}
                  </td>
                  <td>
                    {line.weak.length === 0
                      ? line.total === null
                        ? "—"
                        : "без просадок"
                      : line.weak
                          .map((item) =>
                            item.critical
                              ? `${item.label} (критично)`
                              : item.label,
                          )
                          .join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {opened && (
        <PersonPanel
          line={opened}
          session={session}
          rows={rows.filter(
            (row) => row.evaluation.trainee_id === opened.userId,
          )}
          forecasts={forecasts}
          attempts={attempts.filter((item) => ownerOf(item) === opened.userId)}
          scenarioOf={scenarioOf}
          onNewLesson={onNewLesson}
          onClose={() => setOpenUser(null)}
        />
      )}

      <div className={styles.panel}>
        <h3 className={styles.panelTitle}>Типичные ошибки группы</h3>
        {errors.length === 0 ? (
          <p className={styles.muted}>
            {counts.scored === 0
              ? "Оценённых попыток пока нет."
              : "Просадок по критериям нет."}
          </p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Критерий</th>
                <th>Просели</th>
                <th>Из них критично</th>
                <th>Пример объяснения оценщика</th>
              </tr>
            </thead>
            <tbody>
              {errors.map((item) => (
                <tr key={item.key}>
                  <td>{item.label}</td>
                  <td>
                    {item.attempts} из {item.of}
                  </td>
                  <td>{item.critical || "—"}</td>
                  <td className={styles.muted}>{item.example}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function PersonPanel({
  line,
  session,
  rows,
  forecasts,
  attempts,
  scenarioOf,
  onNewLesson,
  onClose,
}: {
  line: TraineeLine;
  session: Session;
  rows: ReturnType<typeof verdictsForSession>;
  forecasts: ReturnType<typeof forecastLines>;
  attempts: AttemptAnalysis[];
  scenarioOf: (cardId: string) => string | undefined;
  onNewLesson?: (prefill: LessonPrefill) => void;
  onClose: () => void;
}) {
  const advice = recommend(
    line.level,
    rows.map((row) => row.evaluation),
  );
  return (
    <div className={styles.panel} aria-label={`Разбор: ${line.fullName}`}>
      <div className={styles.actions}>
        <h3 className={styles.panelTitle}>
          Разбор: АРМ {line.seat} · {line.fullName} · уровень {line.level}
        </h3>
        <button type="button" className={styles.plain} onClick={onClose}>
          Свернуть
        </button>
      </div>

      {line.recommendation && (
        <div className={styles.note}>
          <strong>Рекомендация сервера: </strong>
          {DIRECTION_LABELS[line.recommendation.direction]}
          {line.recommendation.direction === "keep"
            ? ` уровень ${line.recommendation.level}`
            : ` уровня ${line.recommendation.level}`}
          , вес {line.recommendation.weight}. {line.recommendation.explanation}{" "}
          (по {line.recommendation.based_on_attempts} попыткам)
          {onNewLesson && (
            <>
              {" "}
              <button
                type="button"
                className={styles.primary}
                onClick={() =>
                  onNewLesson({
                    userId: line.userId,
                    level: line.recommendation!.level,
                  })
                }
              >
                Новое занятие с уровнем {line.recommendation.level}
              </button>
            </>
          )}
        </div>
      )}
      {!line.recommendation && (
        <div className={styles.note}>
          <strong>Рекомендация сложности: </strong>
          {advice.kind === "cold" ? (
            <>данных мало — {advice.basis}</>
          ) : (
            <>
              {RECOMMEND_TEXT[advice.kind]}
              {advice.kind === "keep"
                ? ` уровень ${advice.level}`
                : ` уровня ${advice.level}`}
              . Основание: {advice.basis}. Правило команды: от двух оценённых
              попыток; все от 80 % без критических — выше; критическая ошибка
              или ниже 50 % — ниже.
            </>
          )}
          {advice.kind !== "cold" && onNewLesson && (
            <>
              {" "}
              <button
                type="button"
                className={styles.primary}
                onClick={() =>
                  onNewLesson({ userId: line.userId, level: advice.level })
                }
              >
                Новое занятие с уровнем {advice.level}
              </button>
            </>
          )}
        </div>
      )}

      {rows.length === 0 && (
        <p className={styles.muted}>Вердиктов по этому месту пока нет.</p>
      )}
      {rows.map(({ evaluation, card }) => {
        const forecast = forecasts.find(
          (item) => item.cardId === evaluation.card_id,
        );
        const scored = hasScore(evaluation);
        return (
          <div key={evaluation.id} className={styles.attempt}>
            <div className={styles.verdictHead}>
              <span className={scored ? styles.score : styles.scoreNone}>
                {scored
                  ? formatScore(
                      attempts.find(
                        (item) => item.card_id === evaluation.card_id,
                      )?.evaluation?.effective_total ?? evaluation.total,
                    )
                  : "без оценки"}
              </span>
              <div className={styles.verdictWho}>
                <strong>
                  {card
                    ? `Происшествие ${card.source.number} · ${card.source.incident_class}`
                    : `карточка ${evaluation.card_id.slice(0, 8)}`}
                </strong>
                {forecast && (
                  <span className={styles.muted}>
                    прогноз {formatScore(forecast.expectedScore)} за{" "}
                    {formatSeconds(forecast.expectedTimeS)} · факт{" "}
                    {forecast.actualScore === null
                      ? "—"
                      : formatScore(forecast.actualScore)}{" "}
                    за{" "}
                    {forecast.actualTimeS === null
                      ? "—"
                      : formatSeconds(forecast.actualTimeS)}
                  </span>
                )}
              </div>
              <span className={styles.chip}>
                {evaluation.status === "complete"
                  ? "оценка готова"
                  : "предварительно"}
              </span>
            </div>
            <AttemptDetails
              analysis={attempts.find(
                (item) => item.card_id === evaluation.card_id,
              )}
            />
            {scenarioOf(evaluation.card_id) && (
              <ScenarioSource
                scenarioId={scenarioOf(evaluation.card_id) as string}
                className={styles.hint}
              />
            )}
            {evaluation.teacher_comment.trim() && (
              <p className={styles.note}>
                Комментарий преподавателя (виден обучаемому):{" "}
                {evaluation.teacher_comment}
              </p>
            )}
            <ul className={styles.criteriaList}>
              {weakestFirst(evaluation)
                .filter((criterion) => criterion.score < 1)
                .map((criterion) => (
                  <li
                    key={criterion.key}
                    className={
                      criterion.critical ? styles.criticalItem : undefined
                    }
                  >
                    <strong>{criterionLabel(criterion.key)}</strong>
                    {scored && ` — ${formatScore(criterion.score)}`}
                    {criterion.critical && " · критично"}.{" "}
                    {readable(criterion.explanation)}
                    {criterion.evidence.length > 0 && (
                      <span className={styles.muted}>
                        {" "}
                        ({criterion.evidence.map(readable).join("; ")})
                      </span>
                    )}
                  </li>
                ))}
            </ul>
          </div>
        );
      })}
      <p className={styles.hint}>
        Время и балл — как их посчитал сервер для занятия «{session.title}».
      </p>
    </div>
  );
}

/** Время попытки и слои оценки из аналитики — те же строки, что видит обучаемый. */
function AttemptDetails({ analysis }: { analysis?: AttemptAnalysis }) {
  if (!analysis) return null;
  const evaluation = analysis.evaluation;
  return (
    <div className={styles.attemptDetails}>
      {analysis.attempt_status === "interrupted" && (
        <p className={styles.criticalItem}>
          Попытка прервана завершением занятия — карточка не была закрыта.
        </p>
      )}
      <table className={styles.table}>
        <tbody>
          {timeRows(analysis.timing).map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td>
                {row.seconds === null ? "—" : formatSeconds(row.seconds)}
                {row.normative !== null && row.seconds !== null && (
                  <span
                    className={
                      row.verdict === "over"
                        ? styles.criticalItem
                        : styles.muted
                    }
                  >
                    {" "}
                    {row.verdict === "over"
                      ? `· дольше норматива ${formatSeconds(row.normative)}`
                      : `· в нормативе ${formatSeconds(row.normative)}`}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={styles.hint}>
        Время: версия {analysis.timing.timing_version},{" "}
        {QUALITY_LABELS[analysis.timing.quality]}.
      </p>
      {evaluation && (
        <p className={styles.hint}>
          {evaluation.effective_override
            ? `Итог ${formatScore(evaluation.effective_total)} — решение преподавателя (автоматически ${formatScore(evaluation.automatic_total)}). `
            : ""}
          Слои оценки:{" "}
          {evaluation.layers
            .map(
              (layer) =>
                `${LAYER_LABELS[layer.layer]} — ${LAYER_STATUS_LABELS[layer.status]}`,
            )
            .join("; ")}
          .
          {evaluation.partial_reasons.length > 0 &&
            ` Предварительно: ${evaluation.partial_reasons.join(" ")}`}
        </p>
      )}
    </div>
  );
}
