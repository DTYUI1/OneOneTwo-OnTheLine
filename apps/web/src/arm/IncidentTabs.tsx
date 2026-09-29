// Строка состояния поверх любой карточки (27.09, параллельная работа, Q11/FR-1.5).
// Реальный АРМ держит реестр и каждое происшествие в своих вкладках браузера
// (arm_dds/04, 07): диспетчер видит новое происшествие, не закрывая текущее.
// Здесь те же вкладки внутри приложения: реестр, затем происшествия в работе.
// Появление вкладки — момент показа карточки обучаемому: отсюда уходит deliver,
// и с него идут 30 с реакции (I-TIME, «Направление»).
import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Card } from "../shared/api";
import { useSession } from "../shared/session";
import { formatDuration } from "./cardModel";
import { newCardSignal, brigadeCallSignal } from "./signals";
import { trainingQuery } from "./softphone/brigade/data";
import { tabClock, workingCards } from "./tabsModel";
import { useCardActions } from "./useCardActions";
import { useNow } from "./useNow";
import { useParticipant } from "./useParticipant";
import { useWaitingS } from "./useTiming";
import styles from "./IncidentTabs.module.css";

export function IncidentTabs({
  cards,
  openedId,
  listActive,
  onList,
  onOpen,
}: {
  cards: readonly Card[];
  openedId: string | null;
  listActive: boolean;
  onList: () => void;
  onOpen: (id: string) => void;
}) {
  const now = useNow();
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: async () => {
      const { data } = await api.GET("/sessions");
      return data ?? [];
    },
  });
  const running = new Set(
    (sessions.data ?? [])
      .filter((session) => session.status === "running")
      .map((session) => session.id),
  );
  const working = workingCards(cards, running);
  // Нормативы — из снимка занятия карточки (по умолчанию 30 с / 180 с, Q&A Q11).
  const normatives = new Map(
    (sessions.data ?? []).map((session) => [
      session.id,
      {
        reaction: session.settings_snapshot.reaction_normative_s,
        handling: session.settings_snapshot.handling_normative_s,
      },
    ]),
  );
  const fresh = working.filter((card) => card.opened_at === null).length;

  return (
    <nav
      className={styles.tabs}
      aria-label="Происшествия в работе"
      data-help="arm-tabs"
    >
      <button
        type="button"
        className={listActive ? styles.current : styles.tab}
        aria-current={listActive ? "page" : undefined}
        onClick={onList}
      >
        <span className={styles.title}>Список происшествий</span>
        {fresh > 0 && <span className={styles.fresh}>новых: {fresh}</span>}
      </button>
      {working.map((card) => (
        <IncidentTab
          key={card.id}
          card={card}
          current={card.id === openedId}
          now={now}
          normatives={
            normatives.get(card.session_id) ?? { reaction: 30, handling: 180 }
          }
          onOpen={() => onOpen(card.id)}
        />
      ))}
    </nav>
  );
}

function IncidentTab({
  card,
  current,
  now,
  normatives,
  onOpen,
}: {
  card: Card;
  current: boolean;
  now: number;
  normatives: { reaction: number; handling: number };
  onOpen: () => void;
}) {
  const { user, realtime } = useSession();
  const client = useQueryClient();
  const context = useParticipant(card.session_id, user.id);
  const actions = useCardActions(card.id, context.canAct);

  // Вкладка появилась — карточку видно: доставка и один короткий сигнал.
  const delivered = useRef(false);
  useEffect(() => {
    if (!context.canAct || delivered.current || card.delivered_at) return;
    delivered.current = true;
    newCardSignal();
    void actions.deliver();
  }, [actions, card.delivered_at, context.canAct]);

  // Ожидание бригады — только когда идёт обработка: до первичного статуса его нет.
  const handling =
    card.opened_at !== null &&
    card.state !== "added" &&
    card.state !== "received" &&
    card.state !== "rejected";
  const waitingS = useWaitingS(card.id, handling);
  const clock = tabClock(card, now, waitingS, normatives);

  // Бригада звонит сама (CardTraining.incoming): вкладка мигает, пока не ответили.
  const training = useQuery({
    ...trainingQuery(card.id),
    enabled: card.opened_at !== null,
    retry: false,
  });
  useEffect(
    () =>
      realtime.subscribe((event) => {
        if (
          (event.type === "training.updated" &&
            event.payload.card_id === card.id) ||
          event.type === "snapshot"
        )
          void client.invalidateQueries({
            queryKey: trainingQuery(card.id).queryKey,
          });
      }),
    [realtime, client, card.id],
  );
  const incoming = training.data?.incoming ?? [];
  const calls = incoming.map((call) => call.call_id).join(",");
  const heard = useRef(new Set<string>());
  useEffect(() => {
    let rang = false;
    for (const id of calls ? calls.split(",") : []) {
      if (heard.current.has(id)) continue;
      heard.current.add(id);
      rang = true;
    }
    if (rang) brigadeCallSignal();
  }, [calls]);

  const tone =
    incoming.length > 0
      ? styles.calling
      : current
        ? styles.current
        : card.opened_at === null
          ? styles.new
          : styles.tab;
  return (
    <button
      type="button"
      className={tone}
      aria-current={current ? "page" : undefined}
      onClick={onOpen}
    >
      <span className={styles.title}>Происшествие {card.source.number}</span>
      <span className={styles.kind}>{card.source.incident_class}</span>
      {incoming.length > 0 ? (
        <span className={styles.callNote}>Бригада вызывает</span>
      ) : (
        clock && (
          <span className={clock.overdue ? styles.late : styles.clock}>
            {clock.label} {formatDuration(clock.seconds)}
          </span>
        )
      )}
    </button>
  );
}
