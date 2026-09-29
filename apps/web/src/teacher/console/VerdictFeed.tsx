// Лента вердиктов ИИ с разбором по критериям и решением преподавателя.
// Приоритет преподавателя над ИИ — требование заказчика (Q&A Q3, Q13):
// «согласен» фиксируется так же, как «не согласен», и обе записи идут в журнал.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, csrfToken } from "../../shared/api";
import { Replay } from "../replay";
import {
  criterionLabel,
  evaluationNote,
  formatScore,
  hasScore,
  percentToTotal,
  readable,
  verdictsForSession,
  weakestFirst,
  type Card,
  type Evaluation,
  type Session,
} from "./model";
import { useCards, useEvaluations, useUsers } from "./useConsoleData";
import styles from "./Console.module.css";

/**
 * Решение — одно из двух, причина несогласия — отдельно. Раньше причина («согласен» /
 * «не согласен») и кнопки «Согласен» / «Не согласен» дублировали друг друга и могли
 * противоречить. «Другое» открывает поле для своего текста.
 */
const AGREE_REASON = "Согласен с оценкой системы";
const REASONS = {
  disagree: "Не согласен с системой",
  miscalculated: "Система неверно рассчитала",
  other: "Другое",
} as const;
type ReasonChoice = keyof typeof REASONS;
type Decision = "agree" | "disagree";

function VerdictCard({
  evaluation,
  card,
  who,
}: {
  evaluation: Evaluation;
  card: Card | null;
  who: string;
}) {
  const queries = useQueryClient();
  const [decision, setDecision] = useState<Decision>("agree");
  const [choice, setChoice] = useState<ReasonChoice>("disagree");
  const [otherReason, setOtherReason] = useState("");
  const [comment, setComment] = useState("");
  const [newTotal, setNewTotal] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [replaying, setReplaying] = useState(false);
  const note = evaluationNote(evaluation);

  const override = useMutation({
    mutationFn: async () => {
      const reason =
        decision === "agree"
          ? AGREE_REASON
          : choice === "other"
            ? otherReason.trim()
            : REASONS[choice];
      if (!reason) throw new Error("Опишите причину: она попадает в журнал.");
      let total: number | null = null;
      if (decision === "disagree") {
        total = percentToTotal(newTotal);
        if (total === null)
          throw new Error("Укажите новый балл в процентах, от 0 до 100.");
      }
      const { error } = await api.POST("/overrides", {
        params: { header: { "X-CSRF-Token": csrfToken() } },
        body: {
          evaluation_id: evaluation.id,
          decision,
          new_total: total,
          reason,
          teacher_comment: comment.trim(),
        },
      });
      if (error) throw new Error(error.message);
      return decision;
    },
    onSuccess: async (decision: Decision) => {
      setError("");
      setDone(
        decision === "agree"
          ? "Вердикт подтверждён."
          : "Оценка переопределена преподавателем.",
      );
      await queries.invalidateQueries({ queryKey: ["evaluations"] });
      await queries.invalidateQueries({ queryKey: ["report"] });
      await queries.invalidateQueries({
        queryKey: ["replay", evaluation.card_id],
      });
    },
    onError: (cause: Error) => setError(cause.message),
  });

  return (
    <li className={styles.verdict}>
      <div className={styles.verdictHead}>
        <span
          className={hasScore(evaluation) ? styles.score : styles.scoreNone}
        >
          {hasScore(evaluation) ? formatScore(evaluation.total) : "без оценки"}
        </span>
        <div className={styles.verdictWho}>
          <strong>{who}</strong>
          <span>
            {card
              ? `Происшествие ${card.source.number} · ${card.source.incident_class}`
              : `карточка ${evaluation.card_id.slice(0, 8)}`}
          </span>
        </div>
        <span className={styles.chip}>
          {evaluation.status === "complete"
            ? "оценка готова"
            : "предварительно"}
        </span>
      </div>
      {note && <p className={styles.note}>{note}</p>}

      {weakestFirst(evaluation).length === 0 ? (
        <p>Разбора по критериям нет: оценщик не вернул ни одного критерия.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Критерий</th>
              <th>Балл</th>
              <th>Вес</th>
              <th>Почему</th>
            </tr>
          </thead>
          <tbody>
            {weakestFirst(evaluation).map((criterion) => (
              <tr
                key={criterion.key}
                className={criterion.critical ? styles.critical : undefined}
              >
                <td>{criterionLabel(criterion.key)}</td>
                <td>
                  {hasScore(evaluation) ? formatScore(criterion.score) : "—"}
                </td>
                <td>{criterion.weight}</td>
                <td>
                  {readable(criterion.explanation)}
                  {criterion.evidence.length > 0 && (
                    <ul className={styles.evidence}>
                      {criterion.evidence.map((item) => (
                        <li key={item}>{readable(item)}</li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <fieldset className={styles.actions}>
        <legend className={styles.panelTitle}>Решение преподавателя</legend>
        <label>
          <input
            type="radio"
            name={`decision-${evaluation.id}`}
            checked={decision === "agree"}
            onChange={() => setDecision("agree")}
          />{" "}
          Согласен с оценкой
        </label>
        <label>
          <input
            type="radio"
            name={`decision-${evaluation.id}`}
            checked={decision === "disagree"}
            onChange={() => setDecision("disagree")}
          />{" "}
          Не согласен
        </label>
      </fieldset>
      <div className={styles.actions}>
        {decision === "disagree" && (
          <>
            <label className={styles.field}>
              Причина несогласия
              <select
                value={choice}
                onChange={(event) =>
                  setChoice(event.target.value as ReasonChoice)
                }
              >
                {(Object.keys(REASONS) as ReasonChoice[]).map((key) => (
                  <option key={key} value={key}>
                    {REASONS[key]}
                  </option>
                ))}
              </select>
            </label>
            {choice === "other" && (
              <label className={styles.field}>
                Что не так
                <input
                  value={otherReason}
                  onChange={(event) => setOtherReason(event.target.value)}
                  placeholder="обязательно"
                />
              </label>
            )}
            <label className={styles.field}>
              Новый балл, %
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                value={newTotal}
                placeholder="0–100"
                className={styles.number}
                onChange={(event) => setNewTotal(event.target.value)}
              />
            </label>
          </>
        )}
        <label className={styles.field}>
          Комментарий обучаемому
          <input
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
        </label>
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primary}
          disabled={override.isPending}
          onClick={() => override.mutate()}
        >
          Сохранить решение
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {done && <p role="status">{done}</p>}
      <button type="button" onClick={() => setReplaying(!replaying)}>
        {replaying ? "Скрыть разбор" : "Разобрать действия"}
      </button>
      {replaying && <Replay cardId={evaluation.card_id} />}
    </li>
  );
}

export function VerdictFeed({ session }: { session: Session }) {
  const evaluations = useEvaluations();
  const cards = useCards();
  const users = useUsers();
  const rows = verdictsForSession(
    evaluations.data ?? [],
    cards.data ?? [],
    session.id,
  );

  // «Кто»: ФИО и место из состава занятия — по ним преподаватель и решает.
  const who = (traineeId: string) => {
    const name =
      users.data?.find((user) => user.id === traineeId)?.full_name ?? "…";
    const seat = session.participants.find(
      (item) => item.user_id === traineeId,
    )?.workstation_number;
    return seat ? `АРМ ${seat} · ${name}` : name;
  };

  if (evaluations.isPending || cards.isPending)
    return <p className={styles.placeholder}>Загружаем вердикты…</p>;
  if (evaluations.isError || cards.isError)
    return (
      <p role="alert" className={styles.placeholder}>
        Не удалось загрузить вердикты.{" "}
        <button
          type="button"
          className={styles.plain}
          onClick={() => {
            void evaluations.refetch();
            void cards.refetch();
          }}
        >
          Повторить
        </button>
      </p>
    );
  if (rows.length === 0)
    return (
      <p className={styles.placeholder}>
        Вердиктов по этому занятию пока нет: они появляются, когда обучаемый
        закрывает карточку.
      </p>
    );

  return (
    <ul className={styles.verdicts} aria-label="Вердикты ИИ">
      {rows.map(({ evaluation, card }) => (
        <VerdictCard
          key={evaluation.id}
          evaluation={evaluation}
          card={card}
          who={who(evaluation.trainee_id)}
        />
      ))}
    </ul>
  );
}
