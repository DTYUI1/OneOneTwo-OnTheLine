import { describe, expect, it } from "vitest";
import type { Card } from "../../shared/api";
import {
  BRIEF_TEXT,
  placePointer,
  pointerTexts,
  pointerTip,
  STUCK_IDLE_S,
  STUCK_RING_S,
  stuckAfterS,
  WAIT_TEXT,
} from "./pointer";
import { tutorProgress, type TutorEvent } from "./tutor";

const PHONE = "101";
const address: TutorEvent = {
  type: "field_change",
  payload: { field: "address" },
};
const brigade: TutorEvent = { type: "brigades_select", payload: {} };
const report: TutorEvent[] = [
  { type: "call_dial", payload: { call_id: "r", phone_ext: PHONE } },
  { type: "call_answer", payload: { call_id: "r" } },
  { type: "call_hangup", payload: { call_id: "r" } },
];

function tip(
  state: Card["state"],
  events: TutorEvent[],
  extra: { missingReports?: string[]; incoming?: boolean } = {},
) {
  return pointerTip({
    progress: tutorProgress({ state, events }),
    state,
    missingReports: extra.missingReports ?? [],
    incoming: extra.incoming ?? false,
  });
}

describe("pointerTip — куда указывает проводник", () => {
  it("до решения — форма статуса: «Принята», наряд, коротко", () => {
    expect(tip("received", [])).toMatchObject({ target: "action" });
    expect(tip("received", [])?.text).toContain("«Принята»");
  });

  it("«Не принята» в упражнении — вернуть к «Принята»", () => {
    expect(tip("rejected", [])).toMatchObject({ target: "action" });
    expect(tip("rejected", [])?.text).toContain("происшествие ваше");
  });

  it("адреса в подсказках нет: ДДС его не вводит (решение 07.10)", () => {
    expect(tip("accepted", [])).toMatchObject({ target: "brigades" });
    expect(pointerTexts().join(" ")).not.toMatch(/адрес/i);
  });

  it("после «Принята» — бригады на табло сил", () => {
    const t = tip("accepted", [address]);
    expect(t).toMatchObject({ target: "brigades" });
  });

  it("разговор с бригадой на шаге «бригада» — подсказка у вводной, а не у списка сил", () => {
    // Список сил в разговоре скрыт; подсказка садилась на окно телефона (проверка 19.10).
    const t = tip("accepted", [address]);
    expect(t).toMatchObject({ talkText: BRIEF_TEXT, talkTarget: "brief" });
    expect(pointerTexts()).toContain(BRIEF_TEXT);
  });

  it("бригада направлена — сразу выезд: в свою службу проводник не ведёт", () => {
    const t = tip("accepted", [address, brigade], {
      missingReports: ["responding"],
    });
    expect(t).toMatchObject({ target: "brigade-call" });
    expect(pointerTexts().join(" ")).not.toMatch(/свою службу/i);
  });

  it("о выезде не доложено — позвонить бригаде; доложено — статус", () => {
    const events = [address, brigade, ...report];
    expect(
      tip("accepted", events, { missingReports: ["responding"] }),
    ).toMatchObject({
      target: "brigade-call",
    });
    const status = tip("accepted", events);
    expect(status).toMatchObject({ target: "action" });
    expect(status?.text).toContain("«Начало реагирования»");
  });

  it("дальше бригада звонит сама: ждём — подсказки нет, вызывает — «ответьте»", () => {
    const events = [address, brigade, ...report];
    expect(
      tip("responding", events, { missingReports: ["arrived"] }),
    ).toBeNull();
    expect(
      tip("responding", events, {
        missingReports: ["arrived"],
        incoming: true,
      }),
    ).toMatchObject({ target: "answer" });
    expect(tip("working", events)?.text).toContain("итог работ");
  });

  it("карточка закрыта — подсказки нет", () => {
    expect(tip("completed", [address, brigade, ...report])).toBeNull();
  });

  it("бригада на линии — «застрял» наступает раньше", () => {
    const events = [address, brigade, ...report];
    const ring = tip("responding", events, {
      missingReports: ["arrived"],
      incoming: true,
    });
    const status = tip("accepted", events);
    expect(stuckAfterS(ring!)).toBe(STUCK_RING_S);
    expect(stuckAfterS(status!)).toBe(STUCK_IDLE_S);
    expect(STUCK_RING_S).toBeLessThan(STUCK_IDLE_S);
  });

  it("каждая фраза — одна короткая строка, а не абзац", () => {
    for (const text of pointerTexts())
      expect(text.length).toBeLessThanOrEqual(90);
    expect(pointerTexts()).toContain(WAIT_TEXT);
  });
});

describe("placePointer — подсказка не закрывает цель", () => {
  const view = { width: 1366, height: 768 };
  const bubble = { width: 300, height: 60 };

  it("под целью, если внизу есть место; хвостик — на цель", () => {
    const place = placePointer(
      { left: 100, top: 200, width: 120, height: 30 },
      bubble,
      view,
    );
    expect(place.side).toBe("below");
    expect(place.top).toBeGreaterThanOrEqual(230);
    expect(place.left + place.arrow).toBeGreaterThanOrEqual(100);
    expect(place.left + place.arrow).toBeLessThanOrEqual(220);
  });

  it("у нижнего края — над целью и тоже не на ней", () => {
    const target = { left: 100, top: 720, width: 200, height: 40 };
    const place = placePointer(target, bubble, view);
    expect(place.side).toBe("above");
    expect(place.top + bubble.height).toBeLessThanOrEqual(target.top);
  });

  it("у правого края — сдвигается внутрь экрана", () => {
    const place = placePointer(
      { left: 1300, top: 100, width: 60, height: 30 },
      bubble,
      view,
    );
    expect(place.left + bubble.width).toBeLessThanOrEqual(view.width);
    expect(place.arrow).toBeLessThanOrEqual(bubble.width - 12);
  });
});
