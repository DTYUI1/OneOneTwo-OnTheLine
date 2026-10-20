import { describe, expect, it } from "vitest";
import { MIN_LISTEN_MS, reportMayStart } from "./speech";

const answered = 10_000;

describe("Бригада дослушивает диспетчера", () => {
  it("молчит первые 2 с после ответа, даже если доклад готов", () => {
    expect(
      reportMayStart({
        now: answered + MIN_LISTEN_MS - 1,
        talkStartedAt: answered,
      }),
    ).toBe(false);
  });

  it("докладывает через 2 с после ответа", () => {
    expect(
      reportMayStart({
        now: answered + MIN_LISTEN_MS,
        talkStartedAt: answered,
      }),
    ).toBe(true);
  });
});
