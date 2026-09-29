import { describe, expect, it } from "vitest";
import { timingInput } from "../../arm/timingAdapter";
import { calculateTiming } from "../../shared/timing";
import {
  buildTimeline,
  byServerTime,
  type Card,
  clock,
  frameAt,
  nextProblem,
  type Service,
  type Settings,
  type StoredEvent,
  type TimelineInput,
  type CallTarget,
  type InformationEvidence,
  type TimingContext,
  type TimingResult,
} from "./timeline";

const START = Date.parse("2026-09-22T09:00:00.000Z");
const at = (offsetS: number) => new Date(START + offsetS * 1000).toISOString();

let serial = 0;
const event = (
  offsetS: number,
  type: string,
  payload: StoredEvent["payload"] = {},
): StoredEvent => ({
  id: `e-${serial++}`,
  card_id: "card-1",
  actor_id: "u-1",
  client_event_id: `ce-${serial}`,
  client_ts: at(offsetS),
  server_ts: at(offsetS),
  clock_offset_ms: 0,
  type,
  payload,
});

const card: Card = {
  id: "card-1",
  assignment_id: "a-1",
  trainee_id: "u-1",
  session_id: "s-1",
  state: "completed",
  appeared_at: at(0),
  delivered_at: at(0),
  opened_at: at(10),
  closed_at: at(100),
  interrupted_at: null,
  source: { service_ids: ["102"] } as Card["source"],
  current: {} as Card["current"],
};

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
  {
    id: "103",
    code: "103",
    name: "Скорая помощь",
    category: "medical",
    phone_ext: "103",
    voice_profile: "voice-3",
    is_active: true,
  },
];

const settings = {
  reaction_normative_s: 30,
  handling_normative_s: 180,
} as Settings;

const clean: StoredEvent[] = [
  event(0, "deliver"),
  event(10, "open"),
  event(15, "status_change", { state: "accepted", comment: "Принял" }),
  event(16, "field_change", { field: "service_number", value: "23" }),
  event(20, "status_change", { state: "responding", comment: "Реагируем" }),
  event(25, "call_dial", { call_id: "c-1", phone_ext: "102" }),
  event(26, "call_answer", { call_id: "c-1" }),
  event(40, "call_hangup", { call_id: "c-1" }),
  event(100, "status_change", { state: "completed", comment: "Готово" }),
];

const input = (
  events: StoredEvent[],
  over: Partial<TimelineInput> = {},
): TimelineInput => ({ card, events, services, settings, ...over });

describe("Порядок журнала", () => {
  it("строится по серверному времени и не трогает клиентское", () => {
    const shuffled = [clean[3], clean[0], clean[2], clean[1]];
    const ordered = byServerTime(shuffled);
    expect(ordered.map((item) => item.type)).toEqual([
      "deliver",
      "open",
      "status_change",
      "field_change",
    ]);
    expect(ordered[0].client_ts).toBe(shuffled[1].client_ts);
  });
});

describe("Таймлайн", () => {
  it("каждое действие получает подпись словами и секунду от вручения", () => {
    const timeline = buildTimeline(input(clean));
    const steps = timeline.moments.filter((item) => item.kind === "step");
    expect(steps.map((item) => item.title)).toEqual([
      "Карточка вручена",
      "Карточка открыта",
      "Статус: Принята",
      "Номер наряда",
      "Статус: Начало реагирования",
      "Набран номер 102",
      "Абонент ответил",
      "Трубка положена",
      "Статус: Работы завершены",
    ]);
    expect(steps[2].offsetS).toBe(15);
    expect(steps[2].detail).toBe("Принял");
  });

  it("на чистом прогоне ошибок нет", () => {
    expect(buildTimeline(input(clean)).problems).toEqual([]);
  });

  it("длительность считается от вручения до последнего события", () => {
    expect(buildTimeline(input(clean)).totalS).toBe(100);
  });
});

describe("Где обучаемый сбился", () => {
  it("реакция позже норматива", () => {
    const late = clean.map((item) =>
      item.type === "open" ? event(45, "open") : item,
    );
    const [problem] = buildTimeline(input(late)).problems;
    expect(problem.title).toBe("Реакция позже норматива");
    expect(problem.offsetS).toBe(45);
    expect(problem.detail).toContain("45 с");
  });

  it("карточка не открыта вовсе — метка встаёт на норматив", () => {
    const [problem] = buildTimeline(
      input([event(0, "deliver"), event(5, "comment", { comment: "?" })]),
    ).problems;
    expect(problem.title).toBe("Карточка так и не открыта");
    // Метка встаёт на момент, когда норматив истёк, — туда и надо смотреть.
    expect(problem.offsetS).toBe(30);
  });

  it("обработка дольше норматива", () => {
    const slow = clean.map((item) =>
      item.type === "status_change" && item.payload.state === "completed"
        ? event(400, "status_change", { state: "completed", comment: "Готово" })
        : item,
    );
    const problem = buildTimeline(input(slow)).problems.find((item) =>
      item.title.startsWith("Обработка"),
    );
    expect(problem?.offsetS).toBe(400);
  });

  it("звонок не в службу карточки", () => {
    const wrong = clean.map((item) =>
      item.type === "call_dial"
        ? event(25, "call_dial", { call_id: "c-1", phone_ext: "103" })
        : item,
    );
    const problem = buildTimeline(input(wrong)).problems.find((item) =>
      item.title.startsWith("Звонок не в службу"),
    );
    expect(problem?.title).toBe("Звонок не в службу карточки: 103");
    expect(problem?.detail).toContain("102");
  });

  it("звонка не было вовсе", () => {
    const silent = clean.filter((item) => !item.type.startsWith("call_"));
    const problem = buildTimeline(input(silent)).problems.find(
      (item) => item.title === "Звонка не было",
    );
    expect(problem).toBeDefined();
  });

  it("ошибки идут по времени", () => {
    const messy = [
      event(0, "deliver"),
      event(50, "open"),
      event(60, "call_dial", { call_id: "c-1", phone_ext: "103" }),
    ];
    // Карточка осталась открытой, поэтому метки «не закрыта» и «звонка не
    // было» встают на конец журнала, а не на далёкий норматив.
    const problems = buildTimeline(
      input(messy, { card: { ...card, closed_at: null } }),
    ).problems;
    expect(problems.map((item) => item.offsetS)).toEqual([50, 60, 60]);
    expect(problems.map((item) => item.title)).toEqual([
      "Реакция позже норматива",
      "Карточка не закрыта",
      "Звонок не в службу карточки: 103",
    ]);
  });
});

describe("Состояние на момент", () => {
  const timeline = buildTimeline(input(clean));

  it("до открытия карточка только вручена", () => {
    const frame = frameAt(input(clean), timeline, 5);
    expect(frame.state).toBe("received");
    expect(frame.opened).toBe(false);
    expect(frame.callPhase).toBe("none");
  });

  it("в середине видно статус, номер наряда и комментарий", () => {
    const frame = frameAt(input(clean), timeline, 21);
    expect(frame.state).toBe("responding");
    expect(frame.orderNumber).toBe("23");
    expect(frame.comment).toBe("Реагируем");
  });

  it("звонок проходит набор, разговор и отбой", () => {
    const events = input(clean);
    expect(frameAt(events, timeline, 25).callPhase).toBe("dialing");
    expect(frameAt(events, timeline, 30).callPhase).toBe("talking");
    expect(frameAt(events, timeline, 41).callPhase).toBe("ended");
    expect(frameAt(events, timeline, 41).callPhoneExt).toBe("102");
  });

  it("в конце карточка закрыта", () => {
    expect(frameAt(input(clean), timeline, 100).state).toBe("completed");
  });
});

describe("Переход к ошибке", () => {
  const late = buildTimeline(
    input([
      event(0, "deliver"),
      event(50, "open"),
      event(60, "call_dial", { call_id: "c-1", phone_ext: "103" }),
    ]),
  );

  it("вперёд и назад ходит по ошибкам, а не по шагам", () => {
    expect(nextProblem(late, 0, 1)?.offsetS).toBe(50);
    expect(nextProblem(late, 50, 1)?.offsetS).toBe(60);
    expect(nextProblem(late, 60, -1)?.offsetS).toBe(50);
  });

  it("за краем ошибок возвращает null", () => {
    expect(nextProblem(late, 999, 1)).toBeNull();
    expect(nextProblem(late, 0, -1)).toBeNull();
  });
});

describe("Часы", () => {
  it("минуты и секунды", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(95)).toBe("1:35");
    expect(clock(-5)).toBe("0:00");
  });
});

describe("Норматив обработки идёт от открытия (I-TIME §3)", () => {
  // contracts/examples/timing-v2.json, случай base_0_20_40_190:
  // вручено 0, открыто 20, закрыто 190 → реакция 20, обработка 170.
  const contractCase: StoredEvent[] = [
    event(0, "deliver"),
    event(20, "open"),
    event(190, "status_change", { state: "completed", comment: "Готово" }),
  ];

  it("170 секунд обработки при нормативе 180 — это не нарушение", () => {
    // Считая от вручения, вышло бы 190 и разбор показал бы ложную ошибку.
    const problems = buildTimeline(input(contractCase)).problems;
    expect(problems.map((item) => item.title)).not.toContain(
      "Обработка дольше норматива",
    );
  });

  it("повторное открытие не двигает начало обработки", () => {
    const repeated: StoredEvent[] = [
      event(0, "deliver"),
      event(20, "open"),
      event(40, "open"),
      event(190, "status_change", { state: "completed", comment: "Готово" }),
    ];
    expect(
      buildTimeline(input(repeated)).problems.map((item) => item.title),
    ).not.toContain("Обработка дольше норматива");
  });

  it("превышение считается от открытия и так и названо", () => {
    const slow: StoredEvent[] = [
      event(0, "deliver"),
      event(20, "open"),
      event(230, "status_change", { state: "completed", comment: "Готово" }),
    ];
    const problem = buildTimeline(input(slow)).problems.find((item) =>
      item.title.includes("Обработка"),
    );
    expect(problem?.detail).toContain("после открытия");
  });
});

// Снимок v3 — как у новых занятий (TimingPolicy.examples[1]).
const v3: TimingContext = {
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

/** Итог сервера: тот же общий расчёт, но с журналом ожидания, которого нет у клиента. */
const serverTiming = (
  over: Card,
  events: StoredEvent[],
  waitingS: [number, number][],
): TimingResult =>
  calculateTiming({
    ...timingInput(over, events, v3, Date.parse(over.closed_at ?? at(1000))),
    waiting: waitingS.map(([from, to], index) => ({
      message_id: `00000000-0000-4000-8000-00000000000${index}`,
      started_at: at(from),
      ended_at: at(to),
    })),
  });

describe("Время по v3 (contracts/I-TIME.md#v3)", () => {
  it("открытие реакцию не закрывает: без «Принята» — ошибка на нормативе", () => {
    const [problem] = buildTimeline(
      input([event(0, "deliver"), event(5, "open")], { timing: v3 }),
    ).problems;
    expect(problem.title).toBe("Не было «Принята» / «Не принята»");
    expect(problem.offsetS).toBe(30);
  });

  it("пример контракта 0/20/40/190: реакция 40 — позже норматива, обработка 170 — в норме", () => {
    const events = [
      event(0, "deliver"),
      event(20, "open"),
      event(40, "status_change", { state: "accepted", comment: "Принял" }),
      event(190, "status_change", { state: "completed", comment: "Готово" }),
    ];
    const problems = buildTimeline(
      input(events, { card: { ...card, closed_at: at(190) }, timing: v3 }),
    ).problems;
    expect(problems.map((item) => item.title)).toEqual([
      "Реакция позже норматива",
      "Звонка не было",
    ]);
    expect(problems[0].offsetS).toBe(40);
    expect(problems[0].detail).toContain("«Принята» через 40 с");
  });

  it("отсчёт идёт от показа на АРМ (вручения), а не от выдачи", () => {
    // Выдана за 5 с до того, как обучаемый увидел строку: эти 5 с не его.
    const late = { ...card, appeared_at: at(-5), delivered_at: at(0) };
    const timeline = buildTimeline(
      input([event(0, "deliver"), event(20, "open")], {
        card: late,
        timing: v3,
      }),
    );
    expect(timeline.startMs).toBe(Date.parse(at(0)));
    expect(timeline.moments[0].offsetS).toBe(0);
  });

  const slow = [
    event(0, "deliver"),
    event(10, "open"),
    event(15, "status_change", { state: "accepted", comment: "Принял" }),
    event(270, "status_change", { state: "completed", comment: "Готово" }),
  ];
  const slowCard = { ...card, closed_at: at(270) };
  const handlingProblem = (over: Partial<TimelineInput>) =>
    buildTimeline(
      input(slow, { card: slowCard, timing: v3, ...over }),
    ).problems.find((item) => item.title.startsWith("Обработка"));

  it("ожидание сведений вычитается: 260 с обработки, из них 100 ждали бригаду — в норме", () => {
    expect(
      handlingProblem({
        analysis: serverTiming(slowCard, slow, [[30, 130]]),
      }),
    ).toBeUndefined();
  });

  it("без ожидания активная обработка 260 с — превышение, и так и названо", () => {
    const problem = handlingProblem({
      analysis: serverTiming(slowCard, slow, [[30, 50]]),
    });
    expect(problem?.detail).toContain("Активная обработка 240 с");
    expect(problem?.detail).toContain("ожидание сведений 20 с");
  });

  it("ожидание неизвестно (разбор недоступен) — ложной ошибки нет", () => {
    expect(handlingProblem({})).toBeUndefined();
  });

  it("окончательная «Не принята» — терминал: «не закрыта» не пишем", () => {
    const refusedCard = {
      ...card,
      state: "rejected" as const,
      closed_at: null,
    };
    const titles = buildTimeline(
      input(
        [
          event(0, "deliver"),
          event(5, "open"),
          event(10, "status_change", {
            state: "rejected",
            comment: "Не наш район",
          }),
        ],
        { card: refusedCard, timing: v3 },
      ),
    ).problems.map((item) => item.title);
    expect(titles).not.toContain("Карточка не закрыта");
  });
});

describe("Бригады, подсказки и адрес в журнале", () => {
  const target = {
    id: "t-1",
    service_id: "102",
    brigade_id: "b-1",
    name: "Учебный старший бригады 1",
    phone_ext: "203",
    is_active: true,
  } as CallTarget;

  const report = (deliveryId: string, reportText: string) =>
    ({
      delivery: {
        delivery_id: deliveryId,
        card_id: "card-1",
        call_id: "c-2",
        participant_id: "p-1",
        brigade_id: "b-1",
        call_target_id: "t-1",
        message: { text: reportText },
        delivered_at: at(33),
      },
      state: "presented",
      presented_at: at(36),
      failed_at: null,
      presentation_event_id: null,
      failure_reason: null,
    }) as unknown as InformationEvidence;

  const events = [
    event(0, "deliver"),
    event(10, "open"),
    event(12, "hint_open", { hint_id: "phone" }),
    event(15, "status_change", { state: "accepted", comment: "Принял" }),
    event(18, "brigades_select", { brigade_ids: ["b-1"] }),
    event(20, "field_change", {
      field: "address",
      value: {
        city: "Москва",
        street: "Дубнинская улица",
        house: "1",
        building: "",
        apartment: "12",
      },
    }),
    event(30, "call_dial_target", {
      call_id: "c-2",
      call_target_id: "t-1",
      brigade_id: "b-1",
    }),
    event(31, "call_answer", { call_id: "c-2" }),
    event(36, "message_presented", {
      delivery_id: "d-1",
      playback_id: "p-1",
      message_version: 1,
      audio_version: 1,
      channel: "audio",
    }),
    event(44, "message_failed", {
      delivery_id: "d-2",
      playback_id: "p-2",
      message_version: 1,
      audio_version: 1,
      reason: "playback_error",
    }),
  ];
  const withBrigades = input(events, {
    targets: [target],
    messages: [
      report("d-1", "Наряд на месте, обстановку уточняем."),
      report("d-2", "Опрашиваем очевидцев."),
    ],
  });

  it("каждое новое событие названо словами, без идентификаторов", () => {
    const titles = buildTimeline(withBrigades).moments.map((item) => [
      item.title,
      item.detail,
    ]);
    expect(titles).toContainEqual(["Открыта подсказка: телефон", null]);
    expect(titles).toContainEqual(["Направлено бригад: 1", null]);
    expect(titles).toContainEqual([
      "Адрес уточнён",
      "Москва, Дубнинская улица, 1, кв. 12",
    ]);
    expect(titles).toContainEqual([
      "Звонок бригаде 203",
      "Учебный старший бригады 1",
    ]);
    expect(titles).toContainEqual([
      "Доклад бригады прозвучал",
      "Наряд на месте, обстановку уточняем.",
    ]);
    expect(titles).toContainEqual([
      "Доклад бригады не засчитан",
      "сбой воспроизведения: Опрашиваем очевидцев.",
    ]);
  });

  it("на секунде видно, какие доклады обучаемый уже услышал", () => {
    const timeline = buildTimeline(withBrigades);
    expect(frameAt(withBrigades, timeline, 35).reports).toEqual([]);
    const after = frameAt(withBrigades, timeline, 40);
    expect(after.reports).toEqual(["Наряд на месте, обстановку уточняем."]);
    expect(after.callPhoneExt).toBe("203");
    expect(after.callPhase).toBe("talking");
  });
});

describe("Бригада звонит сама (27.09)", () => {
  it("поздний ответ на вызов бригады — место в разборе", () => {
    const problems = buildTimeline(
      input(clean, {
        callbacks: [
          {
            call_id: "cb-1",
            brigade_id: "b-1",
            call_target_id: "t-1",
            started_at: at(40),
            answered_at: at(95),
            ended_at: at(100),
          },
        ],
      }),
    ).problems;
    const late = problems.find((item) => item.title === "Бригада ждала ответа");
    expect(late?.detail).toContain("ждала ответа");
    expect(late?.atMs).toBe(Date.parse(at(40)));
  });
});
