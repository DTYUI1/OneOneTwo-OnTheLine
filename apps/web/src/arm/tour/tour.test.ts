import { afterEach, describe, expect, it, vi } from "vitest";
import { mentorText, voiceUrl } from "../../shared/mascot/mentorVoice";
import { ARM_GUIDE } from "../help/topics";
import {
  markTourOffered,
  OFFER_LINE,
  requestTour,
  subscribeTour,
  TOUR_STEPS,
  tourOffered,
  tourRequests,
} from "./tour";

// Обучение по интерфейсу с наставником: шаги опираются на части «Объяснения экрана» и на
// реплики наставника — сверяем, что ни то ни другое не потерялось.

afterEach(() => vi.unstubAllGlobals());

describe("обучение по интерфейсу", () => {
  it("каждый шаг — реплика с записью, предложение тоже", () => {
    for (const line of [OFFER_LINE, ...TOUR_STEPS.map((step) => step.line)]) {
      expect(mentorText(line)).not.toBe("");
      expect(voiceUrl(line), line).not.toBeNull();
    }
  });

  it("части — из «Объяснения экрана» списка", () => {
    // Порядок свой: сначала весь список, потом его столбцы — так понятнее с голоса.
    for (const step of TOUR_STEPS)
      if ("help" in step.target)
        expect(ARM_GUIDE.order).toContain(step.target.help);
  });

  it("последний шаг — у «?»: там наставник обещает объяснить ещё раз", () => {
    const end = TOUR_STEPS[TOUR_STEPS.length - 1];
    expect(end.target).toEqual({ trigger: true });
    expect(mentorText(end.line)).toContain("Пройти с наставником");
  });

  it("предлагает один раз на пользователя", () => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    });
    expect(tourOffered("u1")).toBe(false);
    markTourOffered("u1");
    expect(tourOffered("u1")).toBe(true);
    expect(tourOffered("u2")).toBe(false);
  });

  it("«Пройти с наставником» просит начать заново", () => {
    const listener = vi.fn();
    const stop = subscribeTour(listener);
    const before = tourRequests();
    requestTour();
    stop();
    expect(tourRequests()).toBe(before + 1);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
