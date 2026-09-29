import { describe, expect, it } from "vitest";
import type { Card } from "../shared/api";
import { tabClock, workingCards } from "./tabsModel";

const card = (id: string, over: Partial<Card> = {}): Card =>
  ({
    id,
    session_id: "s1",
    state: "received",
    appeared_at: "2026-09-27T10:00:00Z",
    closed_at: null,
    interrupted_at: null,
    ...over,
  }) as Card;

describe("вкладки происшествий", () => {
  it("в работе — незакрытые и непрерванные карточки идущего занятия, по появлению", () => {
    const cards = [
      card("late", { appeared_at: "2026-09-27T10:05:00Z" }),
      card("early"),
      card("done", { state: "completed", closed_at: "2026-09-27T10:03:00Z" }),
      card("cut", { interrupted_at: "2026-09-27T10:04:00Z" }),
      card("other", { session_id: "finished" }),
    ];
    expect(workingCards(cards, new Set(["s1"])).map((item) => item.id)).toEqual(
      ["early", "late"],
    );
  });

  const T0 = Date.parse("2026-09-27T10:00:00Z");
  const at = (s: number) => new Date(T0 + s * 1000).toISOString();
  const norms = { reaction: 30, handling: 180 };
  const base = {
    state: "received" as Card["state"],
    delivered_at: at(0),
    opened_at: null as string | null,
    interrupted_at: null as string | null,
  };

  it("до «Принята / Не принята» идёт реакция — с показа, открытие её не останавливает", () => {
    expect(
      tabClock({ ...base, opened_at: at(10) }, T0 + 31_400, null, norms),
    ).toEqual({ label: "реакция", seconds: 31, overdue: true });
  });

  it("не показанная карточка отсчёта не имеет", () => {
    expect(
      tabClock({ ...base, delivered_at: null }, T0 + 60_000, null, norms),
    ).toBeNull();
  });

  it("обработка — с открытия, без ожидания бригады: пока она едет, счёт не краснеет", () => {
    const accepted = {
      ...base,
      state: "responding" as const,
      opened_at: at(0),
    };
    expect(tabClock(accepted, T0 + 250_000, 120, norms)).toEqual({
      label: "обработка",
      seconds: 130,
      overdue: false,
    });
    // Ожидание неизвестно — полная обработка.
    expect(tabClock(accepted, T0 + 250_000, null, norms)?.overdue).toBe(true);
  });

  it("окончательная «Не принята» и прерванная попытка", () => {
    expect(
      tabClock(
        { ...base, state: "rejected", opened_at: at(0) },
        T0,
        null,
        norms,
      ),
    ).toBeNull();
    expect(
      tabClock(
        { ...base, interrupted_at: at(20) },
        T0 + 3_600_000,
        null,
        norms,
      ),
    ).toMatchObject({ seconds: 20 });
  });
});
