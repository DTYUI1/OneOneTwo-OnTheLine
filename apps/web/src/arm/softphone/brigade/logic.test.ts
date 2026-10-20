import { describe, expect, it } from "vitest";
import type { components } from "../../../api-client/schema";
import {
  awaitsDecision,
  directBlock,
  forcesBoard,
  openQuestion,
  lastPlainReport,
  awaitedService,
  LOCAL_DIAL_TRUST_MS,
  pendingMessages,
  serverDials,
  planDial,
  presentedMessages,
  refusalNote,
  silenceLabel,
  stateLabel,
} from "./logic";
import { serverNow } from "../../../shared/ws/client";

type Service = components["schemas"]["Service"];
type CallTarget = components["schemas"]["CallTarget"];
type InformationEvidence = components["schemas"]["InformationEvidence"];

const police: Service = {
  id: "102",
  code: "102",
  name: "Полиция",
  category: "МВД",
  phone_ext: "102",
  voice_profile: "voice-2",
  is_active: true,
};

const brigadeA = "00000000-0000-4000-8000-00000000000a";
const brigadeB = "00000000-0000-4000-8000-00000000000b";

function target(
  id: string,
  phoneExt: string,
  brigadeId: string | null,
  isActive = true,
): CallTarget {
  return {
    id,
    service_id: "102",
    brigade_id: brigadeId,
    name: brigadeId ? "Старший бригады" : "Диспетчер службы",
    phone_ext: phoneExt,
    voice_profile: "voice-2",
    is_active: isActive,
  };
}

const targets = [
  target("t-dispatcher", "102", null),
  target("t-a", "203", brigadeA),
  target("t-b", "204", brigadeB),
  target("t-off", "205", brigadeA, false),
];

describe("набор номера", () => {
  it("прямой номер направленной бригады — звонок адресату", () => {
    const plan = planDial("203", [police], targets, [brigadeA]);
    expect(plan).toEqual({ kind: "target", target: targets[1] });
  });

  it("бригада не направлена — звонок проходит, она ответит отказом", () => {
    expect(planDial("204", [police], targets, [brigadeA])).toEqual({
      kind: "refused",
      target: targets[2],
      reason: "not_assigned",
      busyOn: null,
    });
  });

  it("занятая на другом происшествии бригада отвечает, что занята", () => {
    const busy = new Map([[brigadeB, "7"]]);
    expect(planDial("204", [police], targets, [brigadeA], busy)).toEqual({
      kind: "refused",
      target: targets[2],
      reason: "busy",
      busyOn: "7",
    });
  });

  it("номер общего диспетчера — обычный звонок в службу", () => {
    expect(planDial("102", [police], targets, [brigadeA])).toEqual({
      kind: "service",
      service: police,
    });
  });

  it("неизвестный номер не уходит на сервер", () => {
    expect(planDial("999", [police], targets, [brigadeA]).kind).toBe("unknown");
  });

  it("неактивный адресат и неактивная служба не обслуживаются", () => {
    expect(planDial("205", [police], targets, [brigadeA]).kind).toBe("unknown");
    expect(
      planDial("102", [{ ...police, is_active: false }], [], []).kind,
    ).toBe("unknown");
  });
});

function evidence(
  id: string,
  state: InformationEvidence["state"],
  deliveredAt: string,
  presentedAt: string | null = null,
): InformationEvidence {
  return {
    delivery: {
      delivery_id: id,
      card_id: "card",
      call_id: "call",
      participant_id: "trainee",
      brigade_id: brigadeA,
      call_target_id: "t-a",
      message: { id: `m-${id}`, version: 1, text: id, audio: null },
      delivered_at: deliveredAt,
    },
    state,
    presented_at: presentedAt,
    failed_at: state === "failed" ? deliveredAt : null,
    presentation_event_id: presentedAt ? `e-${id}` : null,
    failure_reason: state === "failed" ? "playback_error" : null,
  };
}

describe("выданные сведения", () => {
  const messages = [
    evidence("third", "delivered", "2026-09-25T10:00:30Z"),
    evidence(
      "first",
      "presented",
      "2026-09-25T10:00:00Z",
      "2026-09-25T10:00:05Z",
    ),
    evidence("second", "failed", "2026-09-25T10:00:10Z"),
  ];

  it("непредъявленные — по времени выдачи, сбой тоже ждёт повтора", () => {
    expect(
      pendingMessages(messages).map((m) => m.delivery.delivery_id),
    ).toEqual(["second", "third"]);
  });

  it("в одну секунду — по времени, а не строкой: ответ бригады раньше доклада", () => {
    const sameSecond = [
      evidence("answer", "delivered", "2026-09-25T10:00:16Z"),
      evidence("report", "delivered", "2026-09-25T10:00:16.000001Z"),
    ];
    expect(
      pendingMessages(sameSecond).map((m) => m.delivery.delivery_id),
    ).toEqual(["answer", "report"]);
  });

  it("повторяет последний доклад, а не вопрос или ответ бригады", () => {
    const report = evidence(
      "arrival",
      "presented",
      "2026-09-25T10:00:00Z",
      "2026-09-25T10:00:05Z",
    );
    const question = evidence(
      "question",
      "presented",
      "2026-09-25T10:00:10Z",
      "2026-09-25T10:00:12Z",
    );
    question.delivery.reply_options = [{ key: "a", label: "Да" }];
    const answer = evidence(
      "answer",
      "presented",
      "2026-09-25T10:00:20Z",
      "2026-09-25T10:00:21Z",
    );
    answer.delivery.answer = true;
    const heard = presentedMessages([report, question, answer]);
    expect(lastPlainReport(heard, brigadeA)).toBe("arrival");
    expect(lastPlainReport(heard, brigadeB)).toBeNull();
  });

  it("не повторяет доклад о выезде: в пути — обещание доложить", () => {
    const departure = evidence(
      "departure",
      "presented",
      "2026-09-25T10:00:00Z",
      "2026-09-25T10:00:05Z",
    );
    departure.delivery.departure = true;
    expect(lastPlainReport([departure], brigadeA)).toBeNull();
    const arrival = evidence(
      "arrival",
      "presented",
      "2026-09-25T10:01:00Z",
      "2026-09-25T10:01:05Z",
    );
    expect(lastPlainReport([departure, arrival], brigadeA)).toBe("arrival");
  });

  it("служба, которую бригада просила последней (HQ-055)", () => {
    const now = Date.parse("2026-09-25T10:01:00Z");
    const report = evidence("arrival", "presented", "2026-09-25T10:00:00Z");
    expect(awaitedService([report], brigadeA, now)).toEqual({
      service: null,
      open: false,
      asked: [],
      opened: [],
      called: [],
    });
    const fire = evidence("fire", "presented", "2026-09-25T10:00:10Z");
    fire.delivery.needs_service = "101";
    const ambulance = evidence(
      "ambulance",
      "presented",
      "2026-09-25T10:00:20Z",
    );
    ambulance.delivery.needs_service = "103";
    expect(awaitedService([report, fire, ambulance], brigadeA, now)).toEqual({
      service: "103",
      open: false,
      asked: ["101", "103"],
      opened: [],
      called: [],
    });
    expect(
      awaitedService([report, fire, ambulance], brigadeB, now).service,
    ).toBeNull();
  });

  it("весть засчитывается от звонка в службу до срока (окно сервера)", () => {
    const ask = evidence("ambulance", "presented", "2026-09-25T10:00:20Z");
    ask.delivery.needs_service = "103";
    const at = (time: string) => Date.parse(`2026-09-25T${time}Z`);
    // В службу ещё не звонили: «скорая будет» — неправда.
    expect(awaitedService([ask], brigadeA, at("10:00:30"))?.open).toBe(false);
    // Звонок в 103 идёт (срока нет) — с удержания можно сказать «отправил».
    ask.delivery.service_called_at = "2026-09-25T10:00:40Z";
    expect(awaitedService([ask], brigadeA, at("10:00:39"))?.open).toBe(false);
    expect(awaitedService([ask], brigadeA, at("10:00:45"))?.open).toBe(true);
    // Отбой в 10:00:50 — скорая на месте в 10:01:10: позже весть не в счёт.
    ask.delivery.news_by = "2026-09-25T10:01:10Z";
    expect(awaitedService([ask], brigadeA, at("10:01:10"))?.open).toBe(true);
    expect(awaitedService([ask], brigadeA, at("10:01:11"))?.open).toBe(false);
    // Позже — тревога о той же скорой, в службу по ней ещё не звонили: окно первой просьбы
    // не закрывается второй.
    const alarm = evidence("alarm", "presented", "2026-09-25T10:01:00Z");
    alarm.delivery.needs_service = "103";
    expect(awaitedService([ask, alarm], brigadeA, at("10:01:05"))).toEqual({
      service: "103",
      open: true,
      asked: ["103", "103"],
      opened: ["103"],
      called: [],
    });
  });

  it("окно вести — по часам сервера, а не компьютера", () => {
    const ask = evidence("ambulance", "presented", "2026-09-25T10:00:20Z");
    ask.delivery.needs_service = "103";
    ask.delivery.service_called_at = "2026-09-25T10:00:40Z";
    ask.delivery.news_by = "2026-09-25T10:01:10Z";
    const at = (time: string) => Date.parse(`2026-09-25T${time}Z`);
    // Часы компьютера отстают на 30 с: на них 10:00:55, у сервера — 10:01:25, скорая уже
    // приехала. Без поправки окно сказало бы «Понял, ждём», а сервер весть не засчитает.
    const offset = 30_000;
    expect(awaitedService([ask], brigadeA, at("10:00:55")).open).toBe(true);
    expect(
      awaitedService([ask], brigadeA, serverNow(offset, at("10:00:55"))).open,
    ).toBe(false);
    // Часы спешат на 30 с: на них 10:01:05, у сервера — 10:00:35, номер ещё не набран.
    expect(
      awaitedService([ask], brigadeA, serverNow(-offset, at("10:01:05"))).open,
    ).toBe(false);
    expect(
      awaitedService([ask], brigadeA, serverNow(-offset, at("10:01:15"))).open,
    ).toBe(true);
  });

  it("свой набор номера службы — пока выдача его не принесла (опрос раз в 2 с)", () => {
    const ask = evidence("ambulance", "presented", "2026-09-25T10:00:20Z");
    ask.delivery.needs_service = "103";
    ask.delivery.delivered_at = "2026-09-25T10:00:20Z";
    const at = (time: string) => Date.parse(`2026-09-25T${time}Z`);
    const dial = { service: "103", at: at("10:00:40"), local: true };
    // Вернулся с удержания через секунду после набора: выдача ещё без service_called_at.
    expect(awaitedService([ask], brigadeA, at("10:00:41"), [dial]).open).toBe(
      true,
    );
    // Через 112 — тоже вызов скорой.
    expect(
      awaitedService([ask], brigadeA, at("10:00:41"), [
        { ...dial, service: "112" },
      ]).open,
    ).toBe(true);
    // Набор до просьбы — не по ней (окно заранее приносит выдача); старый набор не в счёт.
    expect(
      awaitedService([ask], brigadeA, at("10:00:41"), [
        { ...dial, at: at("10:00:10") },
      ]).open,
    ).toBe(false);
    expect(
      awaitedService(
        [ask],
        brigadeA,
        at("10:00:40") + LOCAL_DIAL_TRUST_MS + 1,
        [dial],
      ).open,
    ).toBe(false);
  });

  it("набранные службы: из выдачи и свои (GP-28)", () => {
    const at = (time: string) => Date.parse(`2026-09-25T${time}Z`);
    const dials = serverDials([
      { service_id: "103", started_at: "2026-09-25T10:00:10Z" },
    ]);
    expect(awaitedService([], brigadeA, at("10:00:09"), dials).called).toEqual(
      [],
    );
    expect(awaitedService([], brigadeA, at("10:00:10"), dials).called).toEqual([
      "103",
    ]);
    const local = { service: "101", at: at("10:00:20"), local: true };
    expect(
      awaitedService([], brigadeA, at("10:00:21"), [...dials, local]).called,
    ).toEqual(["103", "101"]);
    // Свой набор, который выдача так и не принесла, со временем не в счёт.
    expect(
      awaitedService([], brigadeA, at("10:00:20") + LOCAL_DIAL_TRUST_MS + 1, [
        ...dials,
        local,
      ]).called,
    ).toEqual(["103"]);
  });

  it("предъявленные остаются на виду в порядке предъявления", () => {
    expect(
      presentedMessages(messages).map((m) => m.delivery.delivery_id),
    ).toEqual(["first"]);
  });
});

describe("табло сил", () => {
  const brigades = [
    { id: brigadeA, service_id: "102", name: "Бригада 1", is_active: true },
    { id: brigadeB, service_id: "102", name: "Бригада 2", is_active: true },
    {
      id: "00000000-0000-4000-8000-00000000000c",
      service_id: "102",
      name: "Бригада 3",
      is_active: true,
    },
  ];

  it("у каждой бригады номер и состояние словами", () => {
    const board = forcesBoard(
      brigades,
      targets,
      [brigadeA],
      new Map([[brigadeB, "7"]]),
    );
    expect(board.map((row) => [row.name, row.ext, stateLabel(row)])).toEqual([
      ["Бригада 1", "203", "направлена сюда"],
      ["Бригада 2", "204", "занята: происшествие 7"],
      ["Бригада 3", null, "свободна"],
    ]);
  });
});

describe("направление бригады после решения", () => {
  it("до «Принята» и после «Не принята» направить нельзя — видно почему", () => {
    expect(directBlock("received")).toContain("«Принята»");
    expect(directBlock("added")).toContain("«Принята»");
    expect(directBlock("rejected")).toContain("не принята");
    expect(directBlock("completed")).toContain("закрыта");
  });

  it("совет «поставьте «Принята»» — только пока решения нет", () => {
    expect(awaitsDecision("received")).toBe(true);
    expect(awaitsDecision("rejected")).toBe(true);
    expect(awaitsDecision("accepted")).toBe(false);
    expect(awaitsDecision("completed")).toBe(false);
    expect(awaitsDecision(null)).toBe(false);
  });

  it("после «Принята» и на этапах реагирования — можно", () => {
    for (const state of [
      "accepted",
      "responding",
      "arrived",
      "working",
    ] as const)
      expect(directBlock(state)).toBeNull();
    expect(directBlock(null)).toBeNull();
  });

  it("после отказа объясняет, что делать, с учётом решения по карточке", () => {
    const free = { reason: "not_assigned", busyOn: null } as const;
    expect(refusalNote(free, true)).toContain("дайте вводную");
    expect(refusalNote(free, false)).toContain("«Принята»");
    expect(refusalNote({ reason: "busy", busyOn: "7" }, true)).toContain(
      "происшествии 7",
    );
    // Бригады нет в списке панели — отметить её нельзя, совет другой.
    expect(refusalNote(free, true, false)).toContain("не в вашем распоряжении");
  });
});

describe("живая бригада (DT-10)", () => {
  const options = [
    { key: "floor_9", label: "Девятый этаж" },
    { key: "unknown", label: "Этаж не знаю — ищите по подъездам" },
  ];
  const asked = (
    id: string,
    state: InformationEvidence["state"],
    reply: string | null = null,
  ): InformationEvidence => {
    const item = evidence(id, state, "2026-10-08T10:00:00Z");
    return {
      ...item,
      delivery: { ...item.delivery, reply_options: options },
      reply_key: reply,
    };
  };

  it("повторный звонок открывает вопрос только той же бригады (PR1-02)", () => {
    const message = asked("rerung", "presented");
    expect(
      openQuestion([message], "new-live-call", [], brigadeA)?.deliveryId,
    ).toBe("rerung");
    expect(openQuestion([message], "new-live-call", [], brigadeB)).toBeNull();
    expect(openQuestion([message], "call", [], brigadeB)).toBeNull();
    expect(openQuestion([message], null, [], brigadeA)).toBeNull();
    expect(
      openQuestion([asked("q", "delivered")], "new-live-call", [], brigadeA),
    ).toBeNull();
    expect(
      openQuestion(
        [asked("q", "presented", "floor_9")],
        "new-live-call",
        [],
        brigadeA,
      ),
    ).toBeNull();
    expect(
      openQuestion([message], "new-live-call", ["rerung"], brigadeA),
    ).toBeNull();
  });

  it("варианты ответа — на услышанный вопрос этого звонка, пока не ответили", () => {
    expect(openQuestion([asked("q", "presented")], "call")).toEqual({
      deliveryId: "q",
      text: "q",
      url: null,
      replyBy: null,
      options,
    });
    expect(openQuestion([asked("q", "delivered")], "call")).toBeNull();
    expect(openQuestion([asked("q", "presented")], "other")).toBeNull();
    expect(
      openQuestion([asked("q", "presented", "floor_9")], "call"),
    ).toBeNull();
    expect(openQuestion([asked("q", "presented")], "call", ["q"])).toBeNull();
    // Повтор вопроса после удержания звучит записью его реплики из сценария (HQ-058).
    const voiced = asked("q", "presented");
    const audio = {
      asset_id: "a",
      version: 1,
      sha256: "s",
      url: "/assets/q.ogg",
      duration_ms: 2000,
    };
    expect(
      openQuestion(
        [
          {
            ...voiced,
            delivery: {
              ...voiced.delivery,
              message: { ...voiced.delivery.message, audio },
            },
          },
        ],
        "call",
      )?.url,
    ).toBe("/assets/q.ogg");
    // Срок ответа — от сервера (`reply_by`, HQ-058).
    expect(
      openQuestion(
        [
          {
            ...voiced,
            delivery: {
              ...voiced.delivery,
              reply_by: "2026-10-18T10:00:30Z",
            },
          },
        ],
        "call",
      )?.replyBy,
    ).toBe(Date.parse("2026-10-18T10:00:30Z"));
    expect(
      openQuestion(
        [evidence("r", "presented", "2026-10-08T10:00:00Z")],
        "call",
      ),
    ).toBeNull();
  });

  it("табло сил показывает, сколько бригада без связи", () => {
    const now = Date.parse("2026-10-08T10:01:20Z");
    expect(silenceLabel("2026-10-08T10:00:00Z", now)).toBe("без связи 1:20");
    expect(silenceLabel(null, now)).toBeNull();
    expect(silenceLabel("2026-10-08T10:01:20Z", now)).toBeNull();
    const [row] = forcesBoard(
      [{ id: brigadeA, service_id: "101", name: "Расчёт 1", is_active: true }],
      [],
      [brigadeA],
      new Map(),
      new Map([[brigadeA, "2026-10-08T10:00:00Z"]]),
    );
    expect(row?.lastContactAt).toBe("2026-10-08T10:00:00Z");
  });
});
