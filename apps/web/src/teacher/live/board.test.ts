import { describe, expect, it } from "vitest";
import {
  alertFor,
  attentionSeats,
  buildBoard,
  type Card,
  type CardClock,
  cardTiming,
  clock,
  CLOCK_CAP_S,
  isActive,
  mostUrgent,
  type Service,
  type Session,
  type StoredEvent,
  type TimingContext,
  type User,
} from "./board";

const NOW = Date.parse("2026-09-22T09:00:30.000Z");
const at = (offsetS: number) => new Date(NOW + offsetS * 1000).toISOString();

// TimingPolicy.examples из contracts/c01.schema.json: v2 и v3.
const POLICY = {
  2: {
    timing_version: 2,
    reaction_normative_s: 30,
    handling_normative_s: 180,
    waiting_policy: "separate",
    max_rtt_ms: 2000,
    max_sample_age_ms: 60000,
    max_buffer_delay_ms: 30000,
    future_tolerance_ms: 250,
  },
  3: {
    timing_version: 3,
    reaction_normative_s: 30,
    handling_normative_s: 180,
    waiting_policy: "exclude_confirmed",
    max_rtt_ms: 2000,
    max_sample_age_ms: 60000,
    max_buffer_delay_ms: 30000,
    future_tolerance_ms: 250,
  },
} as const;

const context = (version: 2 | 3 = 3): TimingContext => ({
  policy: { ...POLICY[version] },
  sessionId: "s-1",
  legacyReactionS: 30,
  legacyHandlingS: 180,
});

const card = (over: Partial<Card> = {}): Card => ({
  id: "card-1",
  assignment_id: "a-1",
  trainee_id: "u-1",
  session_id: "s-1",
  state: "received",
  appeared_at: at(-20),
  // Строка показана на АРМ сразу после выдачи, если тест не говорит иначе.
  delivered_at: over.appeared_at ?? at(-20),
  opened_at: null,
  closed_at: null,
  interrupted_at: null,
  source: {} as Card["source"],
  current: {} as Card["current"],
  ...over,
});

let serial = 0;
/** Событие журнала; `state` — для status_change. */
const event = (
  type: string,
  offsetS: number,
  state?: Card["state"],
): StoredEvent => {
  serial += 1;
  return {
    id: `00000000-0000-4000-8000-${String(serial).padStart(12, "0")}`,
    card_id: "card-1",
    actor_id: "u-1",
    client_event_id: `10000000-0000-4000-8000-${String(serial).padStart(12, "0")}`,
    client_ts: at(offsetS),
    server_ts: at(offsetS),
    clock_offset_ms: 0,
    type,
    payload: state ? { state } : {},
  };
};

const known = (
  events: StoredEvent[],
  waitingS: number | null = null,
): CardClock => ({ events, waitingS });

const user = (id: string, name: string): User => ({
  id,
  login: id,
  full_name: name,
  role: "trainee",
  workstation_number: 1,
  dds_service_id: "102",
  is_active: true,
});

const services: Service[] = [
  {
    id: "102",
    code: "102",
    name: "Служба 102",
    category: "police",
    phone_ext: "102",
    voice_profile: "voice-2",
    is_active: true,
  },
];

const session = (participants: Session["participants"]): Session => ({
  id: "s-1",
  title: "Занятие",
  teacher_id: "t-1",
  status: "running",
  participants,
  settings_snapshot: {
    reaction_normative_s: 30,
    handling_normative_s: 180,
    critical_cap: 0.5,
    weights: {},
    parallel_cards: 2,
    hints_level: 0,
  } as Session["settings_snapshot"],
});

describe("Время карточки по v3 (contracts/I-TIME.md#v3)", () => {
  it("открытие реакцию не закрывает: до «Принята» идёт реакция", () => {
    const timing = cardTiming(
      card({ appeared_at: at(-20), opened_at: at(-10) }),
      known([event("deliver", -19), event("open", -10)]),
      context(),
      NOW,
    );
    expect(timing).toEqual({
      phase: "reaction",
      normativeS: 30,
      remainingS: 10,
      version: 3,
    });
  });

  it("реакция идёт с показа на АРМ, а не с выдачи: задержка входа не в счёт", () => {
    const timing = cardTiming(
      card({ appeared_at: at(-25), delivered_at: at(-15) }),
      known([event("deliver", -15)]),
      context(),
      NOW,
    );
    expect(timing?.remainingS).toBe(15);
  });

  it("после «Принята» — обработка от первого открытия (пример контракта: 40/170)", () => {
    // Направление −190, открытие −170, «Принята» −150: реакция 40, обработка идёт 170.
    const timing = cardTiming(
      card({ state: "accepted", appeared_at: at(-190), opened_at: at(-170) }),
      known([
        event("deliver", -189),
        event("open", -170),
        event("status_change", -150, "accepted"),
      ]),
      context(),
      NOW,
    );
    expect(timing).toEqual({
      phase: "handling",
      normativeS: 180,
      remainingS: 10,
      version: 3,
    });
  });

  it("норматив сравнивается с активной обработкой: ожидание сведений вычитается", () => {
    const timing = cardTiming(
      card({ state: "accepted", appeared_at: at(-190), opened_at: at(-170) }),
      known(
        [event("open", -170), event("status_change", -150, "accepted")],
        60,
      ),
      context(),
      NOW,
    );
    // Полная 170, ожидание 60 → активная 110 из 180.
    expect(timing?.remainingS).toBe(70);
  });

  it("ожидание неизвестно — полная обработка, как на карточке обучаемого", () => {
    const timing = cardTiming(
      card({ state: "accepted", appeared_at: at(-190), opened_at: at(-170) }),
      known([event("open", -170), event("status_change", -150, "accepted")]),
      context(),
      NOW,
    );
    expect(timing?.remainingS).toBe(10);
  });

  it("окончательная «Не принята» — отсчёта нет: это терминал обработки", () => {
    expect(
      cardTiming(
        card({ state: "rejected", appeared_at: at(-30), opened_at: at(-25) }),
        known([event("open", -25), event("status_change", -20, "rejected")]),
        context(),
        NOW,
      ),
    ).toBeNull();
  });

  it("«Не принята → Принята» — обработка снова идёт от первого открытия", () => {
    const timing = cardTiming(
      card({ state: "accepted", appeared_at: at(-60), opened_at: at(-50) }),
      known([
        event("open", -50),
        event("status_change", -40, "rejected"),
        event("status_change", -30, "accepted"),
      ]),
      context(),
      NOW,
    );
    expect(timing?.phase).toBe("handling");
    expect(timing?.remainingS).toBe(130);
  });

  it("«Прибытие» и «Проведение работ» — ещё обработка, а не свободное место", () => {
    const timing = cardTiming(
      card({ state: "working", appeared_at: at(-60), opened_at: at(-50) }),
      known([
        event("open", -50),
        event("status_change", -40, "accepted"),
        event("status_change", -20, "arrived"),
        event("status_change", -10, "working"),
      ]),
      context(),
      NOW,
    );
    expect(timing?.phase).toBe("handling");
    expect(isActive(card({ state: "arrived" }))).toBe(true);
    expect(isActive(card({ state: "working" }))).toBe(true);
  });

  it("занятие со снимком v2 считается по v2: реакцию закрывает открытие", () => {
    const timing = cardTiming(
      card({ appeared_at: at(-20), opened_at: at(-10) }),
      known([event("deliver", -20), event("open", -10)]),
      context(2),
      NOW,
    );
    expect(timing).toEqual({
      phase: "handling",
      normativeS: 180,
      remainingS: 170,
      version: 2,
    });
  });

  it("просрочка показывается отрицательным остатком, а не обнуляется", () => {
    expect(
      cardTiming(card({ appeared_at: at(-42) }), known([]), context(), NOW)
        ?.remainingS,
    ).toBe(-12);
  });

  it("выдана, но не показана на АРМ — реакция без числа", () => {
    expect(
      cardTiming(card({ delivered_at: null }), known([]), context(), NOW),
    ).toMatchObject({ phase: "reaction", remainingS: null });
  });

  it("без журнала — фаза по статусу, без числа: неверный остаток хуже пустого", () => {
    expect(
      cardTiming(card(), { events: undefined, waitingS: null }, context(), NOW),
    ).toEqual({
      phase: "reaction",
      normativeS: 30,
      remainingS: null,
      version: null,
    });
  });
});

describe("Какая карточка на плитке", () => {
  it("закрытые и завершённые в работе не считаются", () => {
    expect(isActive(card())).toBe(true);
    expect(isActive(card({ closed_at: at(-1) }))).toBe(false);
    expect(isActive(card({ state: "completed" }))).toBe(false);
    expect(isActive(card({ state: "refused" }))).toBe(false);
    expect(isActive(card({ state: "redirected" }))).toBe(false);
    // Занятие завершено или тренировка перезапущена — попытка прервана.
    expect(isActive(card({ interrupted_at: at(-1) }))).toBe(false);
  });

  it("из параллельных показывается самая горящая", () => {
    const calm = {
      card: card({ id: "calm" }),
      timing: {
        phase: "handling",
        normativeS: 180,
        remainingS: 175,
        version: 3,
      },
    } as const;
    const burning = {
      card: card({ id: "burning" }),
      timing: { phase: "reaction", normativeS: 30, remainingS: 2, version: 3 },
    } as const;
    expect(mostUrgent([calm, burning])?.card.id).toBe("burning");
  });

  it("без карточек возвращает null", () => {
    expect(mostUrgent([])).toBeNull();
  });
});

describe("Доска", () => {
  const participants: Session["participants"] = [
    { user_id: "u-2", workstation_number: 7, dds_service_id: "103", level: 2 },
    { user_id: "u-1", workstation_number: 1, dds_service_id: "102", level: 1 },
  ];
  const users = [user("u-1", "Иванов И. И."), user("u-2", "Петров П. П.")];

  const board = (
    cards: Card[],
    online: string[],
    clocks: Record<string, CardClock> = {},
  ) =>
    buildBoard({
      session: session(participants),
      users,
      services,
      cards,
      online: new Set(online),
      now: NOW,
      timing: context(),
      clocks: new Map(
        cards.map((item) => [item.id, clocks[item.id] ?? known([])]),
      ),
    });

  it("плитки идут по номеру АРМ и не переставляются", () => {
    const tiles = board([], ["u-1", "u-2"]);
    expect(tiles.map((tile) => tile.workstationNumber)).toEqual([1, 7]);
    expect(tiles[0].fullName).toBe("Иванов И. И.");
  });

  it("без карточки место свободно, без сети — не в сети", () => {
    const tiles = board([], ["u-1"]);
    expect(tiles[0].phase).toBe("free");
    expect(tiles[1].phase).toBe("offline");
  });

  it("считает вторую карточку и помечает просрочку", () => {
    const tiles = board(
      [
        card({ id: "c1", appeared_at: at(-45) }),
        card({ id: "c2", appeared_at: at(-6), opened_at: at(-5) }),
      ],
      ["u-1", "u-2"],
      { c2: known([event("open", -5)]) },
    );
    expect(tiles[0].card?.id).toBe("c1");
    expect(tiles[0].alsoOpen).toBe(1);
    expect(tiles[0].alert).toBe("overdue");
    expect(tiles[0].remainingS).toBe(-15);
    expect(tiles[0].version).toBe(3);
    expect(attentionSeats(tiles)).toEqual({
      soon: [],
      overdue: [1],
      calling: [],
    });
  });

  it("зовёт до провала, а не после: последние секунды норматива", () => {
    const tiles = board(
      [
        card({ id: "c1", appeared_at: at(-27) }),
        card({
          id: "c2",
          trainee_id: "u-2",
          state: "accepted",
          appeared_at: at(-160),
          opened_at: at(-155),
        }),
      ],
      ["u-1", "u-2"],
      {
        // Обработка идёт 155 с из 180 — последние секунды норматива.
        c2: known([
          event("open", -155),
          event("status_change", -150, "accepted"),
        ]),
      },
    );
    expect(tiles[0].alert).toBe("soon");
    expect(tiles[1].alert).toBe("soon");
    expect(attentionSeats(tiles)).toEqual({
      soon: [1, 7],
      overdue: [],
      calling: [],
    });
  });

  it("подтверждённое ожидание сведений снимает тревогу по обработке", () => {
    const accepted = card({
      id: "c1",
      state: "accepted",
      appeared_at: at(-200),
      opened_at: at(-190),
    });
    const events = [
      event("open", -190),
      event("status_change", -185, "accepted"),
    ];
    expect(board([accepted], ["u-1"], { c1: known(events) })[0].alert).toBe(
      "overdue",
    );
    // Из 190 с обработки 50 с бригада докладывала — активная 140 из 180.
    const waited = board([accepted], ["u-1"], { c1: known(events, 50) })[0];
    expect(waited.alert).toBe("none");
    expect(waited.remainingS).toBe(40);
  });

  it("карточка на этапе «Проведение работ» не освобождает место", () => {
    const tiles = board(
      [
        card({
          id: "c1",
          state: "working",
          appeared_at: at(-60),
          opened_at: at(-50),
        }),
      ],
      ["u-1"],
      {
        c1: known([
          event("open", -50),
          event("status_change", -40, "accepted"),
          event("status_change", -10, "working"),
        ]),
      },
    );
    expect(tiles[0].phase).toBe("handling");
    expect(tiles[0].card?.id).toBe("c1");
  });

  it("не в сети с горящей карточкой — зовёт, а не молчит", () => {
    // Обучаемый отошёл от АРМ, а норматив идёт: это главный случай,
    // ради которого доска вообще нужна (Q&A Q11).
    const tiles = board([card({ appeared_at: at(-60) })], []);
    expect(tiles[0].phase).toBe("offline");
    expect(tiles[0].alert).toBe("overdue");
    expect(attentionSeats(tiles).overdue).toEqual([1]);
  });

  it("бригада звонит, а обучаемый не отвечает — место зовёт преподавателя", () => {
    const tiles = board([card({ id: "c1", appeared_at: at(-60) })], ["u-1"], {
      c1: { events: [], waitingS: null, callingSince: at(-40) },
    });
    expect(tiles[0].brigadeWaitS).toBe(40);
    expect(attentionSeats(tiles).calling).toEqual([1]);
  });

  it("пустое место не в сети остаётся тихим", () => {
    const tiles = board([], []);
    expect(tiles[0].alert).toBe("none");
    expect(attentionSeats(tiles)).toEqual({
      soon: [],
      overdue: [],
      calling: [],
    });
  });

  it("чужое занятие на доску не попадает", () => {
    const tiles = board([card({ session_id: "s-2" })], ["u-1"]);
    expect(tiles[0].card).toBeNull();
  });

  it("без занятия доска пуста", () => {
    expect(
      buildBoard({
        session: null,
        users,
        services,
        cards: [card()],
        online: new Set(),
        now: NOW,
        timing: context(),
        clocks: new Map(),
      }),
    ).toEqual([]);
  });

  it("неизвестный участник не ломает доску", () => {
    const tiles = buildBoard({
      session: session([
        {
          user_id: "u-9",
          workstation_number: 3,
          dds_service_id: "101",
          level: 1,
        },
      ]),
      users,
      services,
      cards: [],
      online: new Set(),
      now: NOW,
      timing: context(),
      clocks: new Map(),
    });
    expect(tiles[0].fullName).toBe("Обучаемый");
  });
});

describe("Порог внимания", () => {
  it("реакция зовёт в последние пять секунд", () => {
    expect(alertFor("reaction", 6)).toBe("none");
    expect(alertFor("reaction", 5)).toBe("soon");
    expect(alertFor("reaction", 0)).toBe("soon");
    expect(alertFor("reaction", -1)).toBe("overdue");
  });

  it("обработка — в последние тридцать, та же доля норматива", () => {
    expect(alertFor("handling", 31)).toBe("none");
    expect(alertFor("handling", 30)).toBe("soon");
    expect(alertFor("handling", -1)).toBe("overdue");
  });
});

describe("Часы", () => {
  it("показывают минуты и секунды, просрочку — без знака", () => {
    expect(clock(134)).toBe("2:14");
    expect(clock(7)).toBe("0:07");
    expect(clock(-15)).toBe("0:15");
  });
});

describe("clock", () => {
  it("показывает минуты и секунды", () => {
    expect(clock(95)).toBe("1:35");
  });

  it("не даёт четырёхзначных минут", () => {
    // Карточка со вчерашнего занятия давала 1087:58 — вид сломанного счётчика.
    expect(clock(65278)).toBe("99:59+");
  });

  it("ограничение не трогает то, что норматив ещё измеряет", () => {
    expect(clock(CLOCK_CAP_S)).toBe("99:59");
  });

  it("просроченное время показывает так же, знак несёт подпись", () => {
    expect(clock(-65278)).toBe("99:59+");
  });
});
