import { afterEach, describe, expect, it, vi } from "vitest";
import { bindRoomEscape } from "./roomBridge";

function host() {
  const target = new EventTarget();
  const postMessage = vi.fn();
  return {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    parent: { postMessage },
    postMessage,
  };
}

// Тесты идут в Node: KeyboardEvent нет, хватает события с полем key.
const escape = () =>
  Object.assign(new Event("keydown", { cancelable: true }), {
    key: "Escape",
  });

describe("выход в комнату по Esc", () => {
  afterEach(() => vi.useRealTimers());

  it("свободный Esc просит комнату встать из-за компьютера", () => {
    vi.useFakeTimers();
    const room = host();
    bindRoomEscape(room as never);
    room.dispatchEvent(escape());
    vi.runAllTimers();
    expect(room.postMessage).toHaveBeenCalledWith({ type: "arm112:exit" }, "*");
  });

  it("Esc, который закрыл справку или карточку, комнату не трогает", () => {
    vi.useFakeTimers();
    const room = host();
    bindRoomEscape(room as never);
    const event = escape();
    room.dispatchEvent(event);
    event.preventDefault();
    vi.runAllTimers();
    expect(room.postMessage).not.toHaveBeenCalled();
  });

  it("вне комнаты ничего не делает", () => {
    const alone = host();
    (alone as { parent: unknown }).parent = alone;
    const stop = bindRoomEscape(alone as never);
    alone.dispatchEvent(escape());
    stop();
    expect(alone.postMessage).not.toHaveBeenCalled();
  });
});
