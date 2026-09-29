import { describe, expect, it } from "vitest";
import { START_PROGRESS, startState, type CallerState } from "./dialog";
import {
  nextTip,
  placeBubble,
  tipForCollapsed,
  type GuideInput,
} from "./guide";

const CARD = {
  street: "",
  typeChosen: false,
  selectingType: false,
  tagsAnswered: false,
  description: "",
};

function input(
  state: Partial<CallerState>,
  rest: Partial<GuideInput> = {},
): GuideInput {
  return {
    talking: true,
    saved: false,
    state: { ...startState({ start_panic: 1 }), ...state },
    progress: START_PROGRESS,
    pauseJustHappened: false,
    card: CARD,
    ...rest,
  };
}

describe("проводник первого звонка (этап 3)", () => {
  it("одна подсказка — на следующий шаг, в порядке приёма вызова", () => {
    // Истерика: сначала «Успокоить», потом повтор той же просьбы.
    expect(nextTip(input({ panic: 3 }))?.target).toBe("calm");
    expect(nextTip(input({ panic: 2, calm_reason: 1 }))?.title).toBe(
      "Паника ещё высокая",
    );
    // Адреса нет — вопрос об адресе; прозвучал — внести его в карточку.
    expect(nextTip(input({}))?.title).toBe("Шаг 1 — адрес");
    const heard = { asked: ["address"] };
    expect(nextTip(input(heard))?.target).toBe("street");
    const withStreet = { card: { ...CARD, street: "Дубнинская улица" } };
    expect(nextTip(input(heard, withStreet))?.title).toBe("Спросите ориентир");
    expect(
      nextTip(input({ asked: ["address", "landmark"] }, withStreet))?.title,
    ).toBe("Повторите адрес вслух");
    expect(
      nextTip(
        input({ asked: ["address", "landmark"], confirmed: true }, withStreet),
      )?.title,
    ).toBe("Шаг 2 — номер для связи");
  });

  it("детали шага 5 — до отметок опросной карты: газ узнают раньше, чем отмечают", () => {
    const state = { asked: ["address", "landmark"], confirmed: true };
    const card = { ...CARD, street: "Дубнинская улица", typeChosen: true };
    const talking = (done: number[]) =>
      nextTip(input(state, { card, progress: { step: 5, done } }))?.title;
    expect(talking([1, 2, 3, 4])).toBe("Шаг 5 — детали и доступ");
    expect(talking([1, 2, 3, 4, 5])).toBe("Отметьте опросную карту");
  });

  it("срочное — раньше очередного шага: ухудшение и первая пауза", () => {
    const calm = { asked: ["address"] };
    expect(nextTip(input({ ...calm, escalated: true }))?.target).toBe("advice");
    expect(nextTip(input(calm, { pauseJustHappened: true }))?.target).toBe(
      "hold",
    );
  });

  it("после разговора — карточка: тип, опросная карта, описание, «сохранить»", () => {
    const after = {
      talking: false,
      progress: { step: 5, done: [1, 2, 3, 4, 5] },
    };
    const state = { asked: ["address"], confirmed: true };
    const card = { ...CARD, street: "Дубнинская улица" };
    expect(nextTip(input(state, { ...after, card }))?.target).toBe("type");
    // Пока тип выбирают, подсказка не закрывает список под полем.
    const selecting = { ...card, selectingType: true };
    expect(nextTip(input(state, { ...after, card: selecting }))).toBeNull();
    const typed = { ...card, typeChosen: true };
    expect(nextTip(input(state, { ...after, card: typed }))?.target).toBe(
      "card",
    );
    const tagged = { ...typed, tagsAnswered: true };
    expect(nextTip(input(state, { ...after, card: tagged }))?.target).toBe(
      "description",
    );
    const described = {
      ...tagged,
      description: "Задымление в квартире 47, огня нет, бабушка за дверью.",
    };
    expect(nextTip(input(state, { ...after, card: described }))?.target).toBe(
      "save",
    );
    expect(nextTip(input(state, { ...after, saved: true }))).toBeNull();
  });
});

describe("место подсказки: не закрывает то, на что указывает", () => {
  const viewport = { width: 1366, height: 650 };
  const bubble = { width: 320, height: 90 };

  it("цель в разговоре — подсказка над всей панелью разговора", () => {
    const talk = { left: 700, top: 330, width: 650, height: 240 };
    const calm = { left: 900, top: 332, width: 90, height: 20 };
    const place = placeBubble("calm", calm, bubble, talk, viewport);
    expect(place.side).toBe("above");
    expect(place.top + bubble.height).toBeLessThanOrEqual(talk.top);
    expect(place.left + bubble.width).toBeLessThanOrEqual(viewport.width);
  });

  it("поле — под ним; внизу окна и большие части — над ними", () => {
    const street = { left: 20, top: 200, width: 400, height: 30 };
    const below = placeBubble("street", street, bubble, null, viewport);
    expect(below.side).toBe("below");
    expect(below.top).toBeGreaterThanOrEqual(street.top + street.height);
    const save = { left: 1100, top: 590, width: 120, height: 46 };
    const above = placeBubble("save", save, bubble, null, viewport);
    expect(above.side).toBe("above");
    expect(above.top + bubble.height).toBeLessThanOrEqual(save.top);
    expect(above.left + bubble.width).toBeLessThanOrEqual(viewport.width);
    // Поле типа: под ним открываются списки — подсказка над полем.
    const type = { left: 630, top: 140, width: 700, height: 44 };
    const overType = placeBubble("type", type, bubble, null, viewport);
    expect(overType.side).toBe("above");
    expect(overType.top + bubble.height).toBeLessThanOrEqual(type.top);
  });

  it("разговор у верхнего края — подсказка под всем окном", () => {
    const talk = { left: 20, top: 8, width: 650, height: 320 };
    const calm = { left: 220, top: 10, width: 90, height: 20 };
    const place = placeBubble("calm", calm, bubble, talk, viewport);
    expect(place.side).toBe("below");
    expect(place.top).toBeGreaterThanOrEqual(talk.top + talk.height);
    expect(place.top + bubble.height).toBeLessThanOrEqual(viewport.height);
  });
  it("при увеличении разговора почти до экрана подсказка остаётся видимой", () => {
    const talk = { left: 8, top: 8, width: 1300, height: 620 };
    const calm = { left: 220, top: 10, width: 90, height: 20 };
    const place = placeBubble("calm", calm, bubble, talk, viewport);
    expect(place.top).toBeGreaterThanOrEqual(8);
    expect(place.top + bubble.height).toBeLessThanOrEqual(viewport.height - 8);
  });
});

describe("проводник при свёрнутом разговоре", () => {
  const calm = { target: "calm", title: "Успокойте", text: "…" } as const;
  const street = { target: "street", title: "Адрес", text: "…" } as const;
  it("цель в разговоре — просит развернуть, цель в карточке — остаётся", () => {
    expect(tipForCollapsed(calm, false)).toBe(calm);
    expect(tipForCollapsed(calm, true)?.target).toBe("expand");
    expect(tipForCollapsed(street, true)).toBe(street);
    expect(tipForCollapsed(null, true)).toBeNull();
  });
});
