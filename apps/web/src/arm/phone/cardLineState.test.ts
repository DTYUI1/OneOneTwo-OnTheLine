import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitsLine, LINE_WAIT_MS, requestPickup, takePickup } from "../pickup";
import {
  interruptsCall,
  lineReleased,
  noteTalk,
  openedInPhone,
  talksInPhone,
  type PhoneLine,
} from "./cardLineState";

const final = new Set(["y"]);

describe("разговор финальной смены в окне телефона (HQ-033)", () => {
  it("только карточки финальной смены говорят в окне телефона", () => {
    expect(talksInPhone("y", final, null)).toBe(true);
    expect(talksInPhone("y", final, "x")).toBe(true);
    expect(talksInPhone("x", final, null)).toBe(false);
  });

  it("карточка вызова уже открыта — разговор остаётся её софтфону", () => {
    expect(talksInPhone("y", final, "y")).toBe(false);
  });

  it("ответили из карточки X: линия Y живёт, пока идёт разговор", () => {
    let line: PhoneLine = { cardId: "y", openedAt: "x", talked: false };
    // Трубка ещё не снята — открытая X софтфон не получает, но и линия не отпускается.
    expect(lineReleased(line, false, "x")).toBe(false);
    line = noteTalk(line, true);
    expect(line.talked).toBe(true);
    expect(lineReleased(line, true, "x")).toBe(false);
    // Нашёл карточку Y посреди разговора — линия та же.
    expect(lineReleased(line, true, "y")).toBe(false);
    // Разговор кончился: в Y и в реестре лента остаётся, в другой карточке — её связь.
    expect(lineReleased(line, false, "y")).toBe(false);
    expect(lineReleased(line, false, null)).toBe(false);
    expect(lineReleased(line, false, "z")).toBe(true);
  });

  it("разговор не начался, обучаемый ушёл в другую карточку — линия отпущена", () => {
    const line: PhoneLine = { cardId: "y", openedAt: null, talked: false };
    expect(lineReleased(line, false, "z")).toBe(true);
    expect(noteTalk(line, false)).toBe(line);
  });

  it("переход к другой карточке не обрывает разговор в окне телефона", () => {
    const line: PhoneLine = { cardId: "y", openedAt: null, talked: true };
    expect(interruptsCall({ cardId: "y" }, line)).toBe(false);
    expect(interruptsCall({ cardId: "x" }, line)).toBe(true);
    expect(interruptsCall({ cardId: "x" }, null)).toBe(true);
    expect(interruptsCall(null, line)).toBe(false);
  });
});

describe("открыта X, разговор по Y: кто ведёт окно телефона (HQ-033)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Что видно в окне телефона: софтфон открытой X (контакты, табло сил, набор по X) или
   * линия Y. `lineTaken` — как его считает софтфон линии (`Softphone`, `onCallShown`):
   * разговор на виду или просьба ответить ещё ждёт сведений карточки.
   */
  function windowOf(
    line: PhoneLine | null,
    inCall: boolean,
    now: number,
  ): "x" | "y" {
    const lineTaken = line !== null && (inCall || awaitsLine(line.cardId, now));
    return openedInPhone(line?.cardId ?? null, lineTaken) ? "x" : "y";
  }

  it("от ответа до удержания — только разговор Y, после — контакты X", () => {
    vi.useFakeTimers();
    const start = Date.now();
    expect(windowOf(null, false, start)).toBe("x");
    // Ответили на вызов Y из окна телефона при открытой X: софтфон Y ещё грузит сведения.
    requestPickup("y", "call-y");
    let line: PhoneLine | null = { cardId: "y", openedAt: "x", talked: false };
    expect(windowOf(line, false, start + 2_000)).toBe("y");
    // Сведения пришли, трубка снята — идёт разговор.
    expect(takePickup("y", () => true)).toBe("call-y");
    line = noteTalk(line, true);
    expect(windowOf(line, true, start + 3_000)).toBe("y");
    // Удержание (или отбой): звонка нет — линия отпущена, X снова со своими контактами.
    expect(lineReleased(line, false, "x")).toBe(true);
    line = null;
    expect(windowOf(line, false, start + 4_000)).toBe("x");
  });

  it("вызов ушёл, пока софтфон Y ждал, — окно не занято навсегда", () => {
    vi.useFakeTimers();
    const start = Date.now();
    requestPickup("y", "call-gone");
    const line: PhoneLine = { cardId: "y", openedAt: "x", talked: false };
    expect(windowOf(line, false, start + LINE_WAIT_MS - 1)).toBe("y");
    expect(windowOf(line, false, start + LINE_WAIT_MS)).toBe("x");
    // Убрать просьбу, чтобы не мешала другим тестам модуля.
    expect(takePickup("y", () => true)).toBe("call-gone");
  });
});
