// Стенд live-доски: занятие на 23 места с живыми таймерами, без backend.
// Открывается в dev-режиме, в сборку не попадает.
// Время идёт по-настоящему: видно, как плитка становится янтарной за секунды
// до норматива и красной после него. «Начать заново» переставляет часы.

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import styles from "./LiveBoard.module.css";
import {
  attentionSeats,
  buildBoard,
  type Card,
  type CardClock,
  type Service,
  type Session,
  type StoredEvent,
  type TimingContext,
  type User,
} from "./board";
import { Tile } from "./LiveBoard";
import "../../shared/tokens.css";

const NAMES = [
  "Иванов И. И.",
  "Петров П. П.",
  "Сидоров А. В.",
  "Кузнецов Д. Н.",
  "Смирнов О. Л.",
  "Попов В. В.",
  "Новиков Р. С.",
  "Морозов К. А.",
  "Волков Е. П.",
  "Зайцев М. И.",
  "Соколов Н. Н.",
  "Лебедев Т. В.",
  "Козлов Ю. А.",
  "Егоров С. С.",
  "Павлов Г. М.",
  "Семёнов И. Р.",
  "Голубев А. А.",
  "Виноградов П. К.",
  "Богданов Л. Д.",
  "Воробьёв Ф. И.",
  "Фёдоров Б. О.",
  "Михайлов В. Н.",
  "Беляев Э. Т.",
];
const DDS = ["101", "102", "103", "104", "GKH", "MOSLIFT"];
const KINDS = [
  "пожар: квартира",
  "ДТП с пострадавшими",
  "утечка газа",
  "застрял в лифте",
  "прорыв трубы",
  "задымление",
];

const SERVICES: Service[] = [
  ["101", "Служба 101"],
  ["102", "Служба 102"],
  ["103", "Скорая помощь"],
  ["104", "Мосгаз"],
  ["GKH", "ЖКХ"],
  ["MOSLIFT", "Мослифт"],
].map(([id, name]) => ({
  id,
  code: id,
  name,
  category: "demo",
  phone_ext: "101",
  voice_profile: "voice-1",
  is_active: true,
}));

const users: User[] = NAMES.map((full_name, index) => ({
  id: `u-${index + 1}`,
  login: `trainee${index + 1}`,
  full_name,
  role: "trainee",
  workstation_number: index + 1,
  dds_service_id: DDS[index % DDS.length],
  is_active: true,
}));

const session: Session = {
  id: "s-1",
  title: "Занятие: ДДС, уровни 1–4",
  teacher_id: "t-1",
  status: "running",
  participants: users.map((user, index) => ({
    user_id: user.id,
    workstation_number: index + 1,
    dds_service_id: DDS[index % DDS.length],
    level: (index % 4) + 1,
  })),
  settings_snapshot: {
    reaction_normative_s: 30,
    handling_normative_s: 180,
    critical_cap: 0.5,
    weights: {},
    parallel_cards: 2,
    hints_level: 0,
  } as Session["settings_snapshot"],
};

/** Снимок методики занятия — v3, как у новых занятий (TimingPolicy.examples[1]). */
const timing: TimingContext = {
  sessionId: "s-1",
  policy: {
    timing_version: 3,
    reaction_normative_s: 30,
    handling_normative_s: 180,
    waiting_policy: "exclude_confirmed",
    max_rtt_ms: 2000,
    max_sample_age_ms: 60000,
    max_buffer_delay_ms: 30000,
    future_tolerance_ms: 250,
  },
  legacyReactionS: 30,
  legacyHandlingS: 180,
};

/**
 * Занятие в разгаре: у одних места запас, у других счёт идёт на секунды.
 * `seat` — номер АРМ, `appearedAgoS` — сколько назад направлена карточка,
 * `openedAgoS` — открыта, `acceptedAgoS` — поставлена «Принята» (null — ещё нет).
 * По v3 реакцию закрывает «Принята», а не открытие: места 5 и 19 открыли
 * карточку, но реакция у них всё ещё идёт.
 */
const SCRIPT: ReadonlyArray<
  [
    seat: number,
    appearedAgoS: number,
    openedAgoS: number | null,
    acceptedAgoS: number | null,
  ]
> = [
  [1, 12, null, null],
  [2, 45, null, null],
  [3, 60, 30, 25],
  [4, 200, 190, 185],
  [5, 22, 15, null],
  [5, 100, 20, 15],
  [8, 90, 40, 35],
  [11, 5, null, null],
  [14, 155, 150, 145],
  [19, 33, 28, null],
  // Карточка со вчерашнего занятия: на демо такая даст таймер в тысячу минут.
  // Стоит в сценарии постоянно, чтобы вид «сломанного счётчика» не вернулся
  // незамеченным — 23.09 она наезжала текстом происшествия на таймер.
  [6, 65278, 65200, 65190],
];

function makeCards(origin: number): {
  cards: Card[];
  clocks: Map<string, CardClock>;
} {
  const at = (agoS: number) => new Date(origin - agoS * 1000).toISOString();
  const cards: Card[] = [];
  const clocks = new Map<string, CardClock>();
  SCRIPT.forEach(([seat, appearedAgoS, openedAgoS, acceptedAgoS], index) => {
    const id = `c-${index}`;
    const event = (
      n: number,
      type: string,
      agoS: number,
      payload: StoredEvent["payload"] = {},
    ): StoredEvent => ({
      id: `00000000-0000-4000-8000-${String(index * 10 + n).padStart(12, "0")}`,
      card_id: id,
      actor_id: `u-${seat}`,
      client_event_id: `10000000-0000-4000-8000-${String(index * 10 + n).padStart(12, "0")}`,
      client_ts: at(agoS),
      server_ts: at(agoS),
      clock_offset_ms: 0,
      type,
      payload,
    });
    const events = [event(1, "deliver", appearedAgoS)];
    if (openedAgoS !== null) events.push(event(2, "open", openedAgoS));
    if (acceptedAgoS !== null)
      events.push(
        event(3, "status_change", acceptedAgoS, { state: "accepted" }),
      );
    cards.push({
      id,
      assignment_id: `a-${index}`,
      trainee_id: `u-${seat}`,
      session_id: "s-1",
      state: acceptedAgoS === null ? "received" : "accepted",
      appeared_at: at(appearedAgoS),
      delivered_at: at(appearedAgoS),
      opened_at: openedAgoS === null ? null : at(openedAgoS),
      closed_at: null,
      interrupted_at: null,
      source: {
        number: `3681484${index}`,
        incident_class: KINDS[index % KINDS.length],
      } as Card["source"],
      current: {} as Card["current"],
    });
    clocks.set(id, { events, waitingS: null });
  });
  return { cards, clocks };
}

const online = new Set(
  users
    .map((user) => user.id)
    .filter((_, index) => index !== 6 && index !== 16),
);

function Stand() {
  const [origin, setOrigin] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  const { cards, clocks } = makeCards(origin);
  const tiles = buildBoard({
    session,
    users,
    cards,
    services: SERVICES,
    online,
    now,
    timing,
    clocks,
  });
  const attention = attentionSeats(tiles);

  // Когда всё уже просрочено, смотреть больше не на что: сценарий сам
  // начинается заново, чтобы оставленная открытой вкладка не превращалась
  // в стену красного.
  const nothingLeft = tiles.every(
    (tile) => tile.card === null || tile.alert === "overdue",
  );
  useEffect(() => {
    if (!nothingLeft) return;
    const restart = setTimeout(() => setOrigin(Date.now()), 5000);
    return () => clearTimeout(restart);
  }, [nothingLeft]);
  const seats = (numbers: readonly number[]) =>
    numbers.map((number) => `АРМ ${number}`).join(", ");

  return (
    <section className={styles.board}>
      <div className={styles.head}>
        <h2>{session.title}</h2>
        {attention.overdue.length > 0 && (
          <span className={styles.overdueSeats}>
            Просрочено: {seats(attention.overdue)}
          </span>
        )}
        {attention.soon.length > 0 && (
          <span className={styles.soonSeats}>
            Время на исходе: {seats(attention.soon)}
          </span>
        )}
        {attention.overdue.length + attention.soon.length === 0 && (
          <span className={styles.calm}>Все укладываются в норматив</span>
        )}
        <button type="button" onClick={() => setOrigin(Date.now())}>
          Начать заново
        </button>
      </div>
      <div className={styles.grid}>
        {tiles.map((tile) => (
          <Tile key={tile.userId} tile={tile} />
        ))}
      </div>
      <p style={{ maxWidth: "620px", opacity: 0.8 }}>
        Таймеры идут по-настоящему. Смотрите на АРМ 5 и АРМ 11: за пять секунд
        до норматива реакции плитка становится янтарной, после норматива —
        красной. АРМ 14 проходит тот же путь на нормативе обработки, порог там
        тридцать секунд. Когда все нормативы будут превышены, сценарий начнётся
        сам; «Начать заново» делает то же немедленно.
      </p>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(<Stand />);
