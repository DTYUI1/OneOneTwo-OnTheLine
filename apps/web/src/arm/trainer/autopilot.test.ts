import { afterEach, describe, expect, it, vi } from "vitest";
import { startDemo, stopDemo } from "./autopilot";
import { ghostPress } from "./ghost";
import { SAY } from "./demoModel";
import { trainerStore, type CardVoice } from "./trainerStore";

vi.mock("./ghost", () => ({
  ghostPress: vi.fn(),
  ghostTo: vi.fn(),
  hideGhost: vi.fn(),
}));

// Только граница DOM: сценарий и таймеры автопилота исполняются настоящие.
class Button {
  click = vi.fn();
  getClientRects() {
    return [{}];
  }
  closest() {
    return null;
  }
  querySelector = vi.fn();
}

afterEach(() => {
  vi.mocked(ghostPress).mockReset();
  stopDemo();
  trainerStore.setCard(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("подтверждение без окна подсказки (PR3-02)", () => {
  it.each(["pause", "stop"])(
    "%s в конце выдержки не отправляет поздний Enter статуса",
    async (action) => {
      vi.useFakeTimers();
      vi.stubGlobal("window", { setTimeout });
      vi.stubGlobal("HTMLElement", Button);
      vi.stubGlobal("document", { querySelector: () => null });
      class Input extends Button {
        text = "1";
        get value() {
          return this.text;
        }
        set value(value: string) {
          this.text = value;
        }
        dispatchEvent = vi.fn();
        focus = vi.fn();
      }
      class Select extends Input {}
      vi.stubGlobal("HTMLInputElement", Input);
      vi.stubGlobal("HTMLSelectElement", Select);
      vi.stubGlobal("KeyboardEvent", Event);
      const select = new Select();
      const number = new Input();
      const comment = new Input();
      const form = new Button();
      form.querySelector.mockImplementation((selector: string) =>
        selector === "select"
          ? select
          : selector.includes("Номер наряда")
            ? number
            : comment,
      );
      const root = new Button();
      root.querySelector.mockImplementation((selector: string) =>
        selector.endsWith(" select") ? select : form,
      );
      trainerStore.setCard(
        {
          cardId: "card",
          closed: false,
          check: null,
          step: "decide",
          rejected: false,
          summary: "Пожар",
          tip: { target: "action" },
        } as CardVoice,
        { cardElement: () => root as unknown as HTMLElement },
      );
      let scheduled = false;
      const unsubscribe = trainerStore.subscribe(() => {
        if (scheduled || trainerStore.get().demo?.text !== SAY.enter) return;
        scheduled = true;
        setTimeout(() => {
          if (action === "pause") trainerStore.updateDemo({ paused: true });
          else stopDemo();
        }, 899);
      });
      try {
        startDemo("card", false, vi.fn());
        await vi.advanceTimersByTimeAsync(90_000);
        expect(scheduled).toBe(true);
        expect(
          comment.dispatchEvent.mock.calls.some(
            ([event]) => event.type === "keydown",
          ),
        ).toBe(false);
      } finally {
        unsubscribe();
      }
    },
  );
  it.each(["pause", "stop"])(
    "%s во время анимации не допускает поздний click после передачи управления",
    async (action) => {
      vi.useFakeTimers();
      vi.stubGlobal("window", { setTimeout });
      vi.stubGlobal("HTMLElement", Button);
      vi.stubGlobal("document", { querySelector: () => null });
      const confirm = new Button();
      const root = new Button();
      root.querySelector.mockReturnValue(confirm);
      trainerStore.setCard(
        {
          cardId: "card",
          closed: false,
          check: { status: "completed" },
        } as CardVoice,
        { cardElement: () => root as unknown as HTMLElement },
      );
      vi.mocked(ghostPress).mockImplementation((down) => {
        if (!down) return;
        if (action === "pause") trainerStore.updateDemo({ paused: true });
        else stopDemo();
      });
      startDemo("card", false, vi.fn());
      await vi.advanceTimersByTimeAsync(90_000);
      expect(confirm.click).not.toHaveBeenCalled();
      vi.mocked(ghostPress).mockReset();
    },
  );
  it("нажимает настоящий ✓ карточки и завершает показ, а не кликает корень", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout });
    vi.stubGlobal("HTMLElement", Button);
    vi.stubGlobal("document", { querySelector: () => null });
    const confirm = new Button();
    const root = new Button();
    root.querySelector.mockImplementation((selector: string) =>
      selector.includes("line-confirm") ? confirm : null,
    );
    const card = {
      cardId: "card",
      closed: false,
      check: { status: "completed" },
    } as CardVoice;
    const handlers = { cardElement: () => root as unknown as HTMLElement };
    trainerStore.setCard(card, handlers);
    confirm.click.mockImplementation(() =>
      trainerStore.setCard({ ...card, check: null, closed: true }, handlers),
    );
    const done = vi.fn();
    startDemo(card.cardId, false, done);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(confirm.click).toHaveBeenCalledTimes(1);
    expect(root.click).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledTimes(1);
  });
});
