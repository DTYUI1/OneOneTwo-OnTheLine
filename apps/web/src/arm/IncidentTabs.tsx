// Строка состояния поверх любой карточки (27.09, параллельная работа, Q11/FR-1.5).
// Реальный АРМ держит реестр и каждое происшествие в своих вкладках браузера
// (arm_dds/04, 07): диспетчер видит новое происшествие, не закрывая текущее.
// Здесь те же вкладки внутри приложения: реестр, затем происшествия в работе.
// Появление вкладки — момент показа карточки обучаемому: отсюда уходит deliver,
// и с него идут 30 с реакции (I-TIME, «Направление»). Вкладки — как вкладки браузера
// на скриншотах: «ГБУ Система 112» и «Происшествие N» со значком 112. Учебный таймер
// на вкладке один — сколько идёт отработка карточки (капитан, 19.10): в самой карточке
// ДДС таймера нет, а вкладки — замена вкладок браузера, не экран АРМ.
import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Card } from "../shared/api";
import { useSession } from "../shared/session";
import { newCardSignal } from "./signals";
import { trainingQuery } from "./softphone/brigade/data";
import { tabClock, workBadge, workingCards } from "./tabsModel";
import { useCardActions } from "./useCardActions";
import { useParticipant } from "./useParticipant";
import { useWaitingS } from "./useTiming";
import styles from "./IncidentTabs.module.css";

export function IncidentTabs({
  cards,
  now,
  openedId,
  listActive,
  onList,
  onOpen,
}: {
  cards: readonly Card[];
  /** Часы АРМ — тикает таймер отработки на вкладках. */
  now: number;
  openedId: string | null;
  listActive: boolean;
  onList: () => void;
  onOpen: (id: string) => void;
}) {
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
  // Нормативы — из снимка занятия карточки (по умолчанию 30 с / 3:00, Q&A Q11).
  const normatives = new Map(
    (sessions.data ?? []).map((session) => [
      session.id,
      {
        reaction: session.settings_snapshot.reaction_normative_s,
        handling: session.settings_snapshot.handling_normative_s,
      },
    ]),
  );
  // Финальная смена (HQ-033): вызов бригады подписан только бригадой — вкладка карточки
  // не подсказывает, по какой карточке звонят (звонок слышен, вкладка не мигает).
  const brigadeOnly = new Set(
    (sessions.data ?? [])
      .filter((session) => session.settings_snapshot.final_shift === true)
      .map((session) => session.id),
  );

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
        <span className={styles.logo} aria-hidden="true">
          112
        </span>
        <span className={styles.title}>ГБУ Система 112</span>
      </button>
      {working.map((card) => (
        <IncidentTab
          key={card.id}
          card={card}
          now={now}
          normatives={
            normatives.get(card.session_id) ?? { reaction: 30, handling: 180 }
          }
          current={card.id === openedId}
          hideCaller={brigadeOnly.has(card.session_id)}
          onOpen={() => onOpen(card.id)}
        />
      ))}
    </nav>
  );
}

function IncidentTab({
  card,
  now,
  normatives,
  current,
  hideCaller = false,
  onOpen,
}: {
  card: Card;
  now: number;
  normatives: { reaction: number; handling: number };
  current: boolean;
  /** Финальная смена: входящий бригады не отмечается на вкладке карточки (HQ-033). */
  hideCaller?: boolean;
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

  // Отработка идёт с первичного статуса; ожидание доклада бригады — с сервера, как в оценке.
  const handling =
    card.opened_at !== null &&
    card.state !== "added" &&
    card.state !== "received" &&
    card.state !== "rejected";
  const waitingS = useWaitingS(card.id, handling);
  const work = workBadge(
    tabClock(card, now, waitingS, normatives),
    normatives.handling,
  );

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
  // Тревога бригады (DT-10) — свой сигнал и своя подпись вкладки.
  const alarm = incoming.some((call) => call.priority === "alarm");

  const shown = hideCaller ? [] : incoming;
  const tone =
    shown.length > 0 ? styles.calling : current ? styles.current : styles.tab;
  return (
    <button
      type="button"
      className={tone}
      aria-current={current ? "page" : undefined}
      onClick={onOpen}
    >
      <span className={styles.logo} aria-hidden="true">
        112
      </span>
      <span className={styles.title}>Происшествие {card.source.number}</span>
      {/* Время меняется каждую секунду — не в доступном имени вкладки: по нему её находят. */}
      {work && (
        <span
          className={styles.work}
          data-urgency={work.stage}
          title={work.title}
          aria-hidden="true"
        >
          {work.text}
        </span>
      )}
      {/* Входящий вызов бригады — сигнал связи службы (зона 2), пока её колонка
          не показывает звонки других карточек; в АРМ-112 этого нет. */}
      {shown.length > 0 && (
        <span className={styles.callNote}>
          {alarm ? "Тревога: бригада вызывает" : "Бригада вызывает"}
        </span>
      )}
    </button>
  );
}
