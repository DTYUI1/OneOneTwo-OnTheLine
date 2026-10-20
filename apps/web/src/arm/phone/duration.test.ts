import { describe, expect, it } from "vitest";
import { formatDuration } from "../cardModel";
import { clock } from "./control";
import { heldFor, type HeldLine } from "./hold";
import { minutes } from "./PhoneWindow";
import { phoneTabs } from "./lines";

const held = { heldAt: 0 } as HeldLine;

describe("единый формат длительности без изменения прежних правил (PR3-10)", () => {
  it.each([
    [-1, "0:00", "0:00"],
    [0, "0:00", "0:00"],
    [59.9, "0:59", "1:00"],
    [60, "1:00", "1:00"],
    [65.9, "1:05", "1:06"],
    [5999.5, "99:59", "100:00"],
    [6000, "100:00", "100:00"],
  ] as const)(
    "%s секунд: телефон — прошедшие секунды, контроль — округлённые",
    (seconds, expectedPhone, expectedControl) => {
      expect(minutes(seconds * 1000)).toBe(expectedPhone);
      expect(heldFor(held, seconds * 1000)).toBe(expectedPhone);
      expect(clock(seconds)).toBe(expectedControl);
      const tabs = phoneTabs({
        active: {
          callId: "call",
          cardId: "card",
          cardNumber: "1",
          who: "Бригада",
          talkStartedAt: 0,
        },
        held: [],
        dropped: [],
        rings: [],
        now: seconds * 1000,
      });
      expect(tabs[0]?.state).toBe(`говорит ${expectedPhone}`);
    },
  );
  it("сохраняет предел карточки, но не вводит новый предел для телефона", () => {
    expect(formatDuration(65)).toBe("01:05");
    expect(formatDuration(5999)).toBe("99:59");
    expect(formatDuration(5999.5)).toBe("99:59+");
    expect(formatDuration(6000)).toBe("99:59+");
    expect(formatDuration(6000, { compact: true })).toBe("100:00");
    expect(formatDuration(65.9, { compact: true })).toBe("1:05");
    expect(formatDuration(-1, { compact: true })).toBe("0:00");
  });
});
