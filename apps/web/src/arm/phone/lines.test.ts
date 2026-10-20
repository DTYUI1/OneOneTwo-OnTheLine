import { describe, expect, it } from "vitest";
import type { DroppedLine, HeldLine } from "./hold";
import {
  brigadeWho,
  CONTROL_WHO,
  lineOrder,
  orderTabs,
  phoneTabs,
  type ActiveLine,
  type RingingLine,
} from "./lines";

const active: ActiveLine = {
  callId: "a",
  cardId: "card-1",
  cardNumber: "7",
  who: brigadeWho("201"),
  talkStartedAt: 0,
};
const held: HeldLine = {
  callId: "h",
  cardId: "card-2",
  cardNumber: "8",
  kind: "service",
  phoneExt: "101",
  who: "Служба 101",
  heldAt: 18_000,
};
const ring: RingingLine = {
  callId: "r",
  cardId: "card-3",
  cardNumber: "9",
  who: brigadeWho("202"),
  kind: "brigade",
  alarm: false,
  startedAt: 48_000,
};
const control: RingingLine = {
  ...ring,
  callId: "c",
  who: CONTROL_WHO,
  kind: "control",
  startedAt: 55_000,
};

describe("вкладки линий телефона (проверка 17.10)", () => {
  it("вкладка на каждую линию: кто, состояние, карточка, что делает щелчок", () => {
    const tabs = phoneTabs({
      active,
      held: [held],
      dropped: [],
      rings: [ring, control],
      now: 60_000,
    });
    expect(tabs.map((tab) => [tab.who, tab.state, tab.card, tab.line])).toEqual(
      [
        ["Старший бригады · 201", "говорит 1:00", "по карточке 7", "active"],
        ["Служба 101", "на удержании 0:42", "по карточке 8", "held"],
        ["Старший бригады · 202", "звонит 0:12", "по карточке 9", "ringing"],
        ["Отдел контроля", "звонит 0:05", "по карточке 9", "ringing"],
      ],
    );
    expect(tabs.map((tab) => tab.action)).toEqual([
      null,
      { type: "resume", callId: "h" },
      { type: "answer", cardId: "card-3", callId: "r" },
      { type: "answerControl", cardId: "card-3", callId: "c" },
    ]);
  });

  it("финальная смена: вызов бригады подписан только бригадой (HQ-033)", () => {
    const brigadeHeld: HeldLine = {
      ...held,
      callId: "hb",
      cardId: "card-3",
      kind: "brigade",
      phoneExt: "203",
      who: brigadeWho("203"),
    };
    const tabs = phoneTabs({
      active: null,
      held: [held, brigadeHeld],
      dropped: [],
      rings: [ring, control],
      now: 60_000,
      brigadeOnly: new Set(["card-3"]),
    });
    expect(tabs.map((tab) => [tab.who, tab.card])).toEqual([
      // Служба и отдел контроля по-прежнему называют карточку.
      ["Служба 101", "по карточке 8"],
      ["Старший бригады · 203", null],
      ["Старший бригады · 202", null],
      ["Отдел контроля", "по карточке 9"],
    ]);
  });

  it("разговор с бригадой финальной смены — тоже без «по карточке N» (HQ-033)", () => {
    const only = new Set(["card-1"]);
    const tab = (line: ActiveLine) =>
      phoneTabs({
        active: line,
        held: [],
        dropped: [],
        rings: [],
        now: 60_000,
        brigadeOnly: only,
      })[0]!.card;
    expect(tab({ ...active, kind: "brigade" })).toBeNull();
    // Служба, которой обучаемый звонит сам, и вне финальной смены — с номером карточки.
    expect(tab({ ...active, kind: "service" })).toBe("по карточке 7");
    expect(tab({ ...active, cardId: "card-2", kind: "brigade" })).toBe(
      "по карточке 7",
    );
  });

  it("набор ещё идёт — «вызов…»; тревога — «тревога»; номера нет — без карточки", () => {
    const [dialing, alarm] = phoneTabs({
      active: { ...active, talkStartedAt: null, cardNumber: null },
      held: [],
      dropped: [],
      rings: [{ ...ring, alarm: true }],
      now: 50_000,
    });
    expect(dialing).toMatchObject({ state: "вызов…", card: null });
    expect(alarm).toMatchObject({ state: "тревога 0:02", alarm: true });
  });

  it("не дождался на удержании — вкладка без действия, как в макете и у службы", () => {
    const dropped: DroppedLine[] = [
      { ...held, droppedAt: 1 },
      {
        ...held,
        callId: "b",
        kind: "brigade",
        who: brigadeWho("203"),
        droppedAt: 1,
      },
    ];
    const tabs = phoneTabs({
      active: null,
      held: [],
      dropped,
      rings: [],
      now: 2,
    });
    expect(tabs.map((tab) => [tab.state, tab.action])).toEqual([
      ["не дождался, положил трубку", null],
      ["не дождался, положил трубку", null],
    ]);
  });

  it("одна линия — одна вкладка, даже если она видна в двух списках", () => {
    const tabs = phoneTabs({
      active,
      held: [{ ...held, callId: "a" }],
      dropped: [],
      rings: [{ ...ring, callId: "a" }],
      now: 1,
    });
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.line).toBe("active");
  });

  it("вкладки не прыгают: ответили на звонящую — она на своём месте", () => {
    let order = lineOrder([], ["a", "r"]);
    expect(order).toEqual(["a", "r"]);
    // Ответили на «r»: «a» ушла на удержание, «r» — разговор; порядок прежний.
    const after = phoneTabs({
      active: { ...active, callId: "r" },
      held: [{ ...held, callId: "a" }],
      dropped: [],
      rings: [],
      now: 60_000,
    });
    order = lineOrder(
      order,
      after.map((tab) => tab.id),
    );
    expect(orderTabs(after, order).map((tab) => [tab.id, tab.line])).toEqual([
      ["a", "held"],
      ["r", "active"],
    ]);
    // Новая линия — в конце; линия, которой на миг нет, место не теряет.
    const gap = lineOrder(order, ["r"]);
    expect(gap).toBe(order);
    expect(lineOrder(gap, ["n", "r", "a"])).toEqual(["a", "r", "n"]);
    // Ничего нового — тот же массив; помнит не больше 50 линий.
    expect(lineOrder(order, ["r", "a"])).toBe(order);
    const many = Array.from({ length: 60 }, (_, index) => `x${index}`);
    expect(lineOrder([], many)).toHaveLength(50);
  });
});
