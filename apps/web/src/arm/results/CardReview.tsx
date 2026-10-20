// Разбор одной карточки для обучаемого: оценка, слово преподавателя и факты
// против правил. Баллы — с сервера; здесь только показываем и сравниваем с нормативом.
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../shared/api";
import {
  criterionLabel,
  evaluationNote,
  formatScore,
  hasScore,
  readable,
  weakestFirst,
} from "../../teacher/console/model";
import {
  formatDuration,
  isClosed,
  STATE_LABELS,
  type Service,
} from "../cardModel";
import { useParticipant } from "../useParticipant";
import {
  currentEvaluationAnalysis,
  formatPath,
  fullCycle,
  practiceStepOf,
  regulationEnd,
  regulationText,
  rowVerdict,
  statusComments,
  statusPath,
  type ResultRow,
} from "./resultsModel";
import { analysisRevision, useAttemptAnalysis } from "../useAnalysis";
import { PracticeButton } from "../practice/PracticeButton";
import { AdviceNote } from "../progress/AdviceNote";
import {
  actionFeed,
  afterAction,
  buildDebrief,
  callReviews,
  criteriaSummary,
  differences,
  criterionScoreLabel,
  focusFor,
  helpsUsed,
  LEVEL_LABELS,
  notApplicableLabels,
  sinceText,
  partialReasonLabel,
  scoreSourceLabel,
  traineeEvidence,
  verdictHeading,
  type CallReview,
  type Remark,
  repeatsExplanation,
} from "./debrief";
import { remaining, repeatLine, repeatsOf } from "../progress/progressModel";
import { outcomeFacts, pickOutcome } from "./outcome";
import { BRIGADE_ANSWER_S, lateAnswers, lostReports } from "../callbacks";
import { controlReview } from "../phone/control";
import { holdSummary, holdText } from "../phone/holdReview";
import { callerReview } from "../softphone/caller/review";
import { memoryScore, memoryText } from "../memory/memoryCheck";
import { trainingQuery } from "../softphone/brigade/data";
import { QUALITY_LABELS, timeRows } from "../timeRows";
import { ExpertCompare } from "../trainer/ExpertCompare";
import { sessionMode } from "../trainer/stages";
import { traineeCheckNote } from "../../shared/aiProgress";
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
  // Закрытая карточка читается заново: исход сценария сервер отдаёт только после закрытия.
  const training = useQuery({
    ...trainingQuery(card.id),
    retry: false,
    refetchOnMount: "always",
  });
  const late = lateAnswers(
    training.data?.callbacks ?? [],
    Date.parse(card.closed_at ?? card.interrupted_at ?? "") || Date.now(),
  );
  // Доклад потерян (TC-02): два вызова бригады подряд без ответа.
  const lost = lostReports(training.data?.callbacks ?? []);
  // Звонок отдела контроля (TC-07): сколько карточка была без статуса и пояснение.
  const control = controlReview(training.data?.control);
  const events = useQuery({
    queryKey: ["card-events", card.id],
    queryFn: async ({ signal }) => {
      const { data, error } = await api.GET("/cards/{id}/events", {
        params: { path: { id: card.id } },
        signal,
      });
      if (!data)
        throw new Error(error?.message ?? "Не удалось загрузить действия.");
      return data;
    },
  });
  // Записи звонков карточки (TC-11): сказанное ↔ распознанное ↔ записанное.
  const calls = useQuery({
    queryKey: ["card-calls", card.id],
    queryFn: async ({ signal }) => {
      const { data } = await api.GET("/cards/{id}/calls", {
        params: { path: { id: card.id } },
        signal,
      });
      return data ?? [];
    },
  });
  // Удержание линий (HQ-033): сколько линий держали и сколько ждал собеседник — только показ.
  // Работа с заявителем (HQ-019): паузы, отбой по тишине, срок и просьба подойти — только
  // строки разбора, на балл не влияют (решение капитана 18.10).
  const caller = callerReview(events.data ?? []);
  const holds = holdSummary(
    events.data ?? [],
    Date.parse(card.closed_at ?? card.interrupted_at ?? "") || Date.now(),
  );
  // Проверка памяти финальной смены (HQ-033): в журнале первой карточки смены — только показ.
  const memory = memoryScore(events.data ?? []);
  const context = useParticipant(card.session_id, card.trainee_id);
  const serviceName = (id: string) =>
    services.find((service) => service.id === id)?.name ?? id;

  // Время, решение преподавателя и итог — из серверного разбора попытки.
  const analysis = useAttemptAnalysis({
    cardId: card.id,
    evaluationId: evaluation?.id ?? null,
    evaluationVersion: evaluation?.version ?? null,
    evaluationRevision: analysisRevision(evaluation),
    effectiveTotal: evaluation?.total ?? null,
  });
  const timing = analysis.data?.timing ?? null;
  // При обновлении оценки React Query хранит прошлый ответ до завершения запроса.
  // На это время не показываем старый вердикт как решение преподавателя.
  const evaluationAnalysis = currentEvaluationAnalysis(
    row,
    analysis.isFetching || analysis.isError ? undefined : analysis.data,
  );
  const override = evaluationAnalysis?.effective_override ?? null;
  const path = statusPath(events.data ?? []);
  // «По правилам» — тем статусом, которым карточку закрывает эталон сценария, как в
  // «Что ожидалось»: иначе разбор спорит сам с собой (разбор 18.10, «Отказ»).
  const end = regulationEnd(evaluation?.criteria ?? []);
  const addressed = card.source.service_ids ?? [];
  const own = context.participant?.dds_service_id ?? null;
  const scored = evaluation ? hasScore(evaluation) : false;
  // «Предварительная оценка…» пугает: для обучаемого это просто «оценка уточняется».
  const rawNote = evaluation ? evaluationNote(evaluation) : null;
  const note = rawNote?.startsWith("Предварительная") ? null : rawNote;
  const criteria = evaluation ? weakestFirst(evaluation) : [];
  const debrief = scored && evaluationAnalysis ? buildDebrief(criteria) : null;
  const improvements =
    scored && evaluationAnalysis
      ? new Map(
          buildDebrief(criteria, criteria.length).improve.map((item) => [
            item.key,
            item,
          ]),
        )
      : new Map();
  // «Что было дальше» (DT-08, GP-27): исход сценария карточки по фактам попытки. Исход
  // сценария приходит с разбором (training.outcome); без него — исход тренировки по номеру.
  const outcome =
    scored &&
    !training.isPending &&
    !(training.isFetching && !training.data?.outcome)
      ? pickOutcome({
          number: card.source.number,
          ...outcomeFacts(criteria),
          scenario: training.data?.outcome,
        })
      : null;
  const verdict = rowVerdict(
    row,
    analysis.isFetching || analysis.isError ? undefined : analysis.data,
  );
  const review = scored
    ? afterAction({
        criteria,
        times: timing ? timeRows(timing) : [],
        path: events.isPending ? "" : formatPath(path),
        comments: statusComments(events.data ?? [], card.current.comment),
        teacherComment:
          override?.teacher_comment || evaluation?.teacher_comment || "",
        helps: helpsUsed(events.data ?? []),
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
  // Рекомендация считается по оценке: пришла оценка — путь перечитываем.
  const queries = useQueryClient();
  const evaluationId = evaluation?.id;
  useEffect(() => {
    if (evaluationId)
      void queries.invalidateQueries({ queryKey: ["progress"] });
  }, [evaluationId, queries]);
  const pathStep = progress.data?.steps.find(
    (item) => item.number === (step ?? progress.data?.current_step),
  );
  const focus = debrief ? focusFor(debrief) : undefined;
  const skipped = scored ? notApplicableLabels(criteria) : "";
  const feed = actionFeed(
    events.data ?? [],
    card.delivered_at ?? card.appeared_at,
    timing
      ? {
          reactionOver: timing.reaction_overdue === true,
          handlingOver: timing.handling_overdue === true,
        }
      : null,
  );
  const recorded = callReviews(
    calls.data ?? [],
    events.data ?? [],
    card.delivered_at ?? card.appeared_at,
  );
  // Эта карточка — повтор незачтённой (TC-11): «было → стало» рядом с путём.
  const repeat = progress.data
    ? repeatsOf(progress.data).find(
        (item) => item.last_card_id === card.id && item.now !== null,
      )
    : undefined;

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
          <div role={analysis.isError ? "alert" : "status"}>
            <p className={styles.scoreNone}>
              {scored
                ? evaluationAnalysis?.status === "partial"
                  ? `Проверка продолжается. Сейчас автоматический балл: ${formatScore(evaluationAnalysis.automatic_total)}. Итоговый вердикт появится после проверки. ${traineeCheckNote(evaluation)}`
                  : analysis.isError
                    ? "Балл и решение преподавателя не загрузились. Повторите загрузку."
                    : "Загружаем балл и решение преподавателя. Экран обновится сам."
                : "Оценщик пока не вернул балл."}
            </p>
            {analysis.isError && (
              <button type="button" onClick={() => void analysis.refetch()}>
                Повторить загрузку разбора
              </button>
            )}
          </div>
        )}
        {verdict && evaluation && evaluationAnalysis && (
          <>
            <div className={styles.verdictRow}>
              <p
                className={verdict.passed ? styles.passed : styles.failed}
                role="status"
              >
                <strong>
                  {verdictHeading(verdict, override?.decision ?? null)}
                </strong>{" "}
                ·{" "}
                <span className={styles.percent}>
                  {formatScore(evaluationAnalysis.effective_total)}
                </span>
              </p>
              {practice && (
                <PracticeButton
                  label="Пройти тренировку ещё раз"
                  step={step}
                  again={card.id}
                />
              )}
            </div>
            <p className={styles.muted}>{verdict.detail}</p>
            <p className={styles.scoreSource}>
              {scoreSourceLabel(
                evaluationAnalysis.automatic_total,
                evaluationAnalysis.effective_total,
                override?.decision ?? null,
              )}
            </p>
            {focus && (
              <p className={styles.focus}>
                <strong>Главное на следующую попытку:</strong> {focus.title}.{" "}
                {focus.advice}
              </p>
            )}
          </>
        )}
        {evaluationAnalysis?.status === "partial" && (
          <p className={styles.hint} role="status">
            Оценка частичная
            {evaluationAnalysis.partial_reasons.length > 0
              ? `: ${evaluationAnalysis.partial_reasons.map(partialReasonLabel).join("; ")}`
              : ": часть проверок ещё не завершена или отключена"}
            . Отсутствующие проверки не считаются нулём баллов.
          </p>
        )}
        {pathStep && (
          <p className={styles.hint}>
            Мой путь: ступень {pathStep.number}. {pathStep.title} —{" "}
            {remaining(pathStep)}
          </p>
        )}
        {repeat && (
          <p className={styles.muted}>Повтор карточки: {repeatLine(repeat)}.</p>
        )}
        {evaluation && progress.data?.advice && (
          <AdviceNote
            advice={progress.data.advice}
            cardId={card.id}
            className={styles.focus}
          />
        )}
        {note && <p className={styles.note}>{note}</p>}
      </section>

      {/* «Как сделал бы опытный» (DT-18, макет B) — после карточки тренировки в «Сам». */}
      {practice &&
        isClosed(card) &&
        sessionMode(card.session_id) === "solo" &&
        !events.isPending && (
          <ExpertCompare
            card={card}
            events={events.data ?? []}
            criteria={criteria}
            reactionNormative={timing?.reaction_normative_s ?? 30}
            servicePhone={
              services.find((service) => service.id === own)?.phone_ext ?? null
            }
            // Курсор опытного проходит только учебную карточку (ступень 1, упражнение): в
            // сценарии ступени или каталога показ открывал бы её же, а не эту (проверка 17.10).
            replayable={
              step === 1 ||
              session?.title === "Тренировка: полный цикл карточки"
            }
            className={styles.block}
          />
        )}

      {outcome && (
        <section className={styles.block} aria-labelledby="outcome-title">
          <h4 id="outcome-title">Что было дальше</h4>
          {outcome.paragraphs.map((text) => (
            <p key={text} className={styles.outcome}>
              {text}
            </p>
          ))}
          {outcome.why && (
            <p className={styles.muted}>
              <strong>Почему это важно.</strong> {outcome.why}
            </p>
          )}
          <p className={styles.hint}>
            Учебная иллюстрация по фактам вашей попытки, не прогноз.
          </p>
        </section>
      )}

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
          {override?.reason.trim() && (
            <p className={styles.overrideReason}>
              <strong>Причина решения:</strong> {override.reason}
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
          <h4 id="debrief-title">
            {evaluationAnalysis?.status === "partial"
              ? "Промежуточные итоги"
              : "Итоги"}
          </h4>
          {/* Разбор по четырём вопросам (After Action Review): главное — первым. */}
          <dl className={styles.aar}>
            <dt>Что сделать иначе</dt>
            <dd>
              {debrief.improve.length === 0 ? (
                <p>
                  {evaluationAnalysis?.status === "partial"
                    ? "По уже проверенным критериям замечаний нет. Проверка продолжается."
                    : "Замечаний нет: попытка выполнена по правилам."}
                </p>
              ) : (
                <ol className={styles.improve}>
                  {debrief.improve.map((item) => (
                    <li key={item.key}>
                      <strong>{item.title}</strong>{" "}
                      <span
                        className={styles.level}
                        data-level={item.notice ? undefined : item.level}
                      >
                        {item.notice
                          ? "без снижения балла"
                          : item.critical
                            ? "критическая ошибка"
                            : LEVEL_LABELS[item.level]}
                      </span>
                      {item.remarks.length > 0 ? (
                        item.remarks.map((remark) => (
                          <RemarkView key={remark.text} remark={remark} />
                        ))
                      ) : (
                        <>
                          <p>{item.advice}</p>
                          {item.fact && (
                            <p className={styles.muted}>{item.fact}</p>
                          )}
                        </>
                      )}
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
            {debrief.data.length > 0 && (
              <>
                <dt>Вопрос к данным</dt>
                <dd>
                  {debrief.data.map((remark) => (
                    <RemarkView key={remark.text} remark={remark} />
                  ))}
                </dd>
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
          {events.isError && (
            <p role="alert" className={styles.hint}>
              Хронология действий не загрузилась. {events.error.message}{" "}
              <button type="button" onClick={() => void events.refetch()}>
                Повторить
              </button>
            </p>
          )}
          {feed.length > 0 && (
            <details className={styles.more}>
              <summary>Лента действий</summary>
              <p className={styles.muted}>
                Время — от показа карточки; «+» — сколько прошло с прошлого
                действия.
              </p>
              <ol className={styles.timeline} aria-label="Лента действий">
                {feed.map((line, index) => (
                  <li
                    key={`${line.at}-${index}`}
                    className={line.over ? styles.bad : undefined}
                  >
                    <span className={styles.at}>{formatDuration(line.at)}</span>{" "}
                    <span className={styles.since}>
                      {sinceText(line.since)}
                    </span>{" "}
                    {line.label}
                    {line.over && " — позже норматива"}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </section>
      )}

      {recorded.length > 0 && (
        <section className={styles.block} aria-labelledby="calls-title">
          <h4 id="calls-title">Записи звонков</h4>
          {recorded.map((call) => (
            <CallView key={call.id} call={call} />
          ))}
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
            {analysis.isError && (
              <tr>
                <td colSpan={4} role="alert">
                  Время попытки не загрузилось. Повторите загрузку разбора выше.
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
                    ) : line.verdict === "estimated" ? (
                      <span className={styles.muted}>
                        норматив не проверен, штрафа нет
                      </span>
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
              <td>
                {events.isPending
                  ? "загружаем…"
                  : events.isError
                    ? "не удалось загрузить"
                    : formatPath(path)}
              </td>
              <td>{regulationText(end)}</td>
              <td>
                {events.isSuccess && (
                  <Verdict
                    ok={fullCycle(path, end)}
                    good={
                      end === "completed"
                        ? "принята и завершена"
                        : `закрыта: ${STATE_LABELS[end]}`
                    }
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
        {lost.map((wait) => (
          <p key={wait.callId} className={styles.hint} role="note">
            Доклад бригады потерян: она звонила с ним дважды, оба вызова
            остались без ответа. Дальше бригада не звонила сама — доклад можно
            было получить, только позвонив ей.
          </p>
        ))}
        {caller && (
          <p className={styles.hint} role="note" data-caller-review="">
            Работа с заявителем: {caller.join(" ")}
          </p>
        )}
        {holds && (
          <p className={styles.hint} role="note" data-hold-review="">
            {holdText(holds)}
          </p>
        )}
        {memory && (
          <p className={styles.hint} role="note" data-memory-review="">
            {memoryText(memory)}.
          </p>
        )}
        {control && (
          <p className={styles.hint} role="note" data-control-review="">
            {control}
          </p>
        )}
      </section>

      <section className={styles.block}>
        <h4>Разбор по критериям</h4>
        {scored && !evaluationAnalysis ? (
          <p className={styles.muted}>
            Загружаем актуальный разбор критериев. До его загрузки баллы не
            показываются, чтобы не спутать их с решением преподавателя.
          </p>
        ) : criteria.length === 0 ? (
          <p className={styles.muted}>
            Оценщик пока не вернул разбора по критериям.
          </p>
        ) : debrief ? (
          // Главное уже в «Итогах»: полный список — по запросу, для самопроверки.
          <>
            {evaluationAnalysis?.status === "partial" && (
              <p className={styles.hint}>
                Критерии ниже предварительные: часть проверок не завершена.
                Окончательные замечания появятся после проверки.
              </p>
            )}
            <AllCriteria
              criteria={criteria}
              scored={scored}
              improvements={improvements}
            />
          </>
        ) : (
          <CriteriaList
            criteria={criteria}
            scored={scored}
            improvements={improvements}
          />
        )}
      </section>
    </article>
  );
}

/**
 * Замечание разбора (TC-10): что не так, цитата сказанного или написанного, последствие
 * в мире вместо минуса, «Повторите: …» и страница памятки ДДС.
 */
function RemarkView({ remark }: { remark: Remark }) {
  return (
    <div className={styles.remark}>
      <p>{remark.text}</p>
      {remark.quote && (
        <blockquote className={styles.quote}>{remark.quote}</blockquote>
      )}
      {/* У вопроса к данным не последствие, а почему обучаемому это не вменяется. */}
      <p>
        {remark.kind !== "data" && <strong>Последствие: </strong>}
        {remark.consequence}
      </p>
      <p>
        {remark.repeat}{" "}
        <span className={styles.memo}>Памятка ДДС, с. {remark.memo_page}.</span>
      </p>
    </div>
  );
}

/**
 * Звонок на разборе (TC-11): запись — переслушать сказанное, рядом распознанный текст и то,
 * что записано в комментарий после звонка.
 */
function CallView({ call }: { call: CallReview }) {
  return (
    <div className={styles.call}>
      <p>
        <strong>
          {call.at === null ? "" : `${formatDuration(call.at)} · `}
          {call.label}
        </strong>
      </p>
      <dl className={styles.aar}>
        <dt>Сказано</dt>
        <dd>
          {call.audioUrl ? (
            <audio
              controls
              preload="none"
              src={call.audioUrl}
              aria-label={`Запись: ${call.label}`}
            />
          ) : (
            "Запись звонка не сохранена."
          )}
        </dd>
        <dt>Распознано</dt>
        <dd>
          {call.recognized.length > 0
            ? call.recognized.map((text) => <p key={text}>«{text}»</p>)
            : "Распознанного текста нет: сверяйте запись с комментарием на слух."}
        </dd>
        <dt>Записано в комментарий</dt>
        <dd>
          {call.written
            ? `«${call.written}»`
            : "После звонка комментарий не записан."}
        </dd>
      </dl>
    </div>
  );
}

/**
 * «Все критерии» со сводкой «✓ совпало N · ! расхождения N» и флажком «только
 * расхождения» (TC-11): при многих критериях сразу видно, что разбирать.
 */
function AllCriteria({
  criteria,
  scored,
  improvements,
}: {
  criteria: ReturnType<typeof weakestFirst>;
  scored: boolean;
  improvements: Map<string, ReturnType<typeof buildDebrief>["improve"][number]>;
}) {
  const [onlyDiffer, setOnlyDiffer] = useState(false);
  const summary = criteriaSummary(criteria);
  const shown = onlyDiffer ? differences(criteria) : criteria;
  return (
    <details className={styles.more}>
      <summary>
        Все критерии ·{" "}
        <span className={styles.ok}>✓ совпало {summary.matched}</span> ·{" "}
        <span className={summary.differ > 0 ? styles.bad : undefined}>
          ! расхождения {summary.differ}
        </span>
      </summary>
      <label className={styles.filter}>
        <input
          type="checkbox"
          checked={onlyDiffer}
          onChange={(event) => setOnlyDiffer(event.target.checked)}
        />{" "}
        только расхождения
      </label>
      {shown.length > 0 ? (
        <CriteriaList
          criteria={shown}
          scored={scored}
          improvements={improvements}
        />
      ) : (
        <p className={styles.muted}>Расхождений нет.</p>
      )}
    </details>
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
  improvements,
}: {
  criteria: ReturnType<typeof weakestFirst>;
  scored: boolean;
  improvements: Map<string, ReturnType<typeof buildDebrief>["improve"][number]>;
}) {
  return (
    <ul className={styles.criteria}>
      {criteria.map((criterion) => {
        const evidence = traineeEvidence(criterion.evidence);
        const improvement = improvements.get(criterion.key);
        return (
          <li
            key={criterion.key}
            className={criterion.critical ? styles.critical : undefined}
          >
            <div className={styles.criterionHead}>
              <strong>{criterionLabel(criterion.key)}</strong>
              <span>{!scored ? "—" : criterionScoreLabel(criterion)}</span>
            </div>
            {criterion.weight === 0 && (
              <p className={styles.hint}>Вес 0: на итог не влияет.</p>
            )}
            {criterion.weight > 0 && (
              <p className={styles.hint}>
                Вес в итоговой оценке: {criterion.weight}.
              </p>
            )}
            <p>
              <strong>Основание:</strong> {readable(criterion.explanation)}
            </p>
            {improvement && (
              <>
                {improvement.fact &&
                  !repeatsExplanation(
                    improvement.fact,
                    criterion.explanation,
                  ) && (
                    <p>
                      <strong>Что повлияло:</strong> {improvement.fact}
                    </p>
                  )}
                <p>
                  <strong>Как исправить:</strong> {improvement.advice}
                </p>
              </>
            )}
            {evidence.length > 0 && (
              <details className={styles.more}>
                <summary>Факты проверки ({evidence.length})</summary>
                <ul className={styles.evidence}>
                  {evidence.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </details>
            )}
            {(criterion.remarks ?? []).map((remark) => (
              <p key={remark.text} className={styles.muted}>
                {remark.consequence} Памятка ДДС, с. {remark.memo_page}.
              </p>
            ))}
          </li>
        );
      })}
    </ul>
  );
}
