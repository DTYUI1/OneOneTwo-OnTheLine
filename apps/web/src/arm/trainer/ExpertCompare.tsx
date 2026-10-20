// «Как сделал бы опытный» в разборе карточки тренировки (DT-18, макет B: `compareView`
// и кнопка `rv-expert`). Упражнение ступени 1 повторяется курсором тренажёра — потом
// здесь сравнение с этой карточкой. Ступени 2–4 так не повторить (сценарий тренировки
// выбирается случайно), поэтому сравнение — с эталоном сценария от оценщика.
import { useQuery } from "@tanstack/react-query";
import { api, type Card } from "../../shared/api";
import { readable } from "../../teacher/console/model";
import { notApplicable } from "../results/debrief";
import type { components } from "../../api-client/schema";
import {
  compareSummary,
  compareWithExpert,
  compareWithReference,
  movesOf,
} from "./compare";
import { expertCardFor } from "./stages";
import { useTrainer } from "./TrainerContext";
import styles from "./Trainer.module.css";

type StoredEvent = components["schemas"]["StoredEvent"];
type Criterion = components["schemas"]["CriterionResult"];

export function ExpertCompare({
  card,
  events,
  criteria,
  reactionNormative,
  servicePhone,
  replayable,
  className,
}: {
  readonly card: Card;
  readonly events: readonly StoredEvent[];
  readonly criteria: readonly Criterion[];
  readonly reactionNormative: number;
  readonly servicePhone: string | null;
  /** Карточку можно пройти курсором ещё раз (упражнение ступени 1). */
  readonly replayable: boolean;
  /** Класс блока разбора — сравнение стоит в ряду его разделов. */
  readonly className?: string;
}) {
  const trainer = useTrainer();
  const expertId = expertCardFor(card.id);
  const cards = useQuery({
    queryKey: ["cards"],
    queryFn: async () => (await api.GET("/cards")).data ?? [],
    enabled: expertId !== null,
  });
  const expert = cards.data?.find((item) => item.id === expertId) ?? null;
  const expertEvents = useQuery({
    queryKey: ["card-events", expertId],
    enabled: expertId !== null,
    queryFn: async ({ signal }) => {
      const { data } = await api.GET("/cards/{id}/events", {
        params: { path: { id: expertId ?? "" } },
        signal,
      });
      return data ?? [];
    },
  });

  const mine = movesOf(
    events,
    card.delivered_at ?? card.appeared_at,
    servicePhone,
  );
  if (expert && expertEvents.data) {
    const rows = compareWithExpert(
      mine,
      movesOf(
        expertEvents.data,
        expert.delivered_at ?? expert.appeared_at,
        servicePhone,
      ),
    );
    return (
      <Table
        rows={rows}
        caption={`${compareSummary(rows)} · время от показа карточки`}
        className={className}
      />
    );
  }
  if (replayable)
    return (
      <p className={styles.expert}>
        <button
          type="button"
          className={styles.btn}
          disabled={!trainer || trainer.busy}
          title={
            trainer?.busy
              ? "Тренировка запускается — подождите несколько секунд"
              : !trainer
                ? "Доступно в окне АРМ диспетчера"
                : undefined
          }
          onClick={() => trainer?.watchExpert(card.id)}
        >
          Как сделал бы опытный
        </button>{" "}
        <span>
          курсор пройдёт эту же карточку, потом здесь появится сравнение с вашим
          ходом
        </span>
      </p>
    );
  if (criteria.length === 0) return null;
  const flow = criteria.find((item) => item.key === "status_flow");
  const line = (prefix: string) =>
    flow?.evidence
      .map(readable)
      .find((item) => item.startsWith(prefix))
      ?.replace(new RegExp(`^${prefix}:\\s*`), "") ?? null;
  const call = criteria.find((item) => item.key === "call");
  const rows = compareWithReference(mine, {
    reactionNormative,
    path: line("Эталон"),
    fact: line("Факт"),
    pathOk: (flow?.score ?? 0) >= 1,
    callRequired: call !== undefined && call.weight > 0 && !notApplicable(call),
  });
  return (
    <Table
      rows={rows}
      caption={`${compareSummary(rows)} · по эталону сценария, время от показа карточки`}
      className={className}
    />
  );
}

function Table({
  rows,
  caption,
  className,
}: {
  readonly rows: readonly ReturnType<typeof compareWithExpert>[number][];
  readonly caption: string;
  readonly className?: string;
}) {
  return (
    <section className={className} aria-label="Как сделал бы опытный">
      <h4>
        Как сделал бы опытный <span className={styles.caption}>{caption}</span>
      </h4>
      <table className={styles.cmp}>
        <thead>
          <tr>
            <th />
            <th>Опытный</th>
            <th>Вы</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.title} className={row.diff ? styles.diff : undefined}>
              <td>{row.title}</td>
              <td>{row.pro}</td>
              <td>{row.mine}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
