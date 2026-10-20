// Вводные преподавателя на live-доске (DT-06, #69): «Добавить событие ▾» на всё занятие и у плитки
// места, итог подачи по каждому месту и лента поданных. Вводная — событие сценария,
// поданное вручную (contracts/scenario-events.md, раздел 4): что подать, решает сервер по
// карточке каждого адресата; неприменимо — он называет причину.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, csrfToken } from "../../shared/api";
import type { components } from "../../api-client/schema";
import styles from "./LiveBoard.module.css";

type Overview = components["schemas"]["InjectOverview"];
type Receipt = components["schemas"]["InjectReceipt"];
type Kind = components["schemas"]["InjectInput"]["kind"];

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });

export function useInjects(sessionId: string, running: boolean) {
  const queries = useQueryClient();
  const key = ["session-injects", sessionId];
  const overview = useQuery({
    queryKey: key,
    enabled: running,
    // Применимость меняется с ходом карточек (бригада на месте — тревогу можно подать).
    refetchInterval: running ? 5000 : false,
    queryFn: async (): Promise<Overview> => {
      const { data, error } = await api.GET("/sessions/{id}/injects", {
        params: { path: { id: sessionId } },
      });
      if (!data) throw new Error(error?.message ?? "Нет связи с сервером.");
      return data;
    },
  });
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [failure, setFailure] = useState("");
  const [pending, setPending] = useState(false);

  async function send(kind: Kind, targets: "all" | string[]) {
    setPending(true);
    setFailure("");
    const { data, error } = await api.POST("/sessions/{id}/injects", {
      params: {
        path: { id: sessionId },
        header: { "X-CSRF-Token": csrfToken() },
      },
      body: { kind, targets },
    });
    setPending(false);
    if (!data) {
      setFailure(error?.message ?? "Вводная не подана: нет связи с сервером.");
      return;
    }
    setReceipt(data);
    void queries.invalidateQueries({ queryKey: key });
  }

  return {
    options: overview.data?.options ?? [],
    fired: overview.data?.fired ?? [],
    receipt,
    failure,
    pending,
    send,
    dismiss: () => {
      setReceipt(null);
      setFailure("");
    },
  };
}

export type Injects = ReturnType<typeof useInjects>;

/** Кнопка «Добавить событие ▾» с меню видов: на всё занятие или на одно место. */
export function InjectMenu({
  injects,
  targets,
  label,
}: {
  injects: Injects;
  targets: "all" | string[];
  /** Для кого — в подписи кнопки для экранного диктора: «Добавить событие: АРМ 5». */
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const none = injects.options.length === 0;
  return (
    <span className={styles.injectWrap}>
      <button
        type="button"
        className={styles.injectButton}
        aria-expanded={open}
        aria-label={`Добавить событие: ${label}`}
        disabled={none || injects.pending}
        title={
          none
            ? "В открытых карточках нет событий, которые можно подать вводной"
            : "Подать событие сценария по ходу занятия"
        }
        onClick={() => setOpen((value) => !value)}
      >
        Добавить событие ▾
      </button>
      {open && (
        <span className={styles.injectMenu} role="menu">
          {injects.options.map((option) => (
            <button
              key={option.kind}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void injects.send(option.kind, targets);
              }}
            >
              <strong>{option.title}</strong>
              <span>
                {targets === "all"
                  ? `примут карточек: ${option.cards}`
                  : "Доступность зависит от сценария и хода занятия"}
              </span>
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

/** Итог подачи по местам и лента поданных вводных. */
export function InjectFeed({ injects }: { injects: Injects }) {
  const { receipt, failure, fired } = injects;
  return (
    <section className={styles.injects} aria-label="Вводные">
      {(receipt || failure) && (
        <div className={styles.injectResult} role="status">
          {failure && <p>{failure}</p>}
          {receipt && (
            <ul>
              {receipt.results.map((result) => (
                <li key={result.participant_id}>
                  <strong>АРМ {result.workstation}</strong> ·{" "}
                  {result.status === "fired"
                    ? `подана, карточка ${result.card_number}`
                    : `не подана: ${result.reason}`}
                </li>
              ))}
            </ul>
          )}
          <button type="button" onClick={injects.dismiss}>
            Понятно
          </button>
        </div>
      )}
      <h3>Поданные вводные</h3>
      {fired.length === 0 ? (
        <p className={styles.calm}>Пока не подавались.</p>
      ) : (
        <ol className={styles.injectList}>
          {fired.map((item) => (
            <li key={item.id}>
              <span className={styles.clock}>{time(item.fired_at)}</span> ·{" "}
              {item.title} · АРМ {item.workstation} · {item.trainee_name} ·
              карточка {item.card_number}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
