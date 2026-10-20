// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { PracticeAvailabilityNotice, PracticeButton } from "./PracticeButton";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  openIntro: vi.fn(),
  introSeen: true,
  running: false,
  blockedReason: "",
  note: "",
}));
vi.mock("./usePracticeStart", () => ({
  usePracticeStart: () => ({
    start: mocks.start,
    running: mocks.running,
    disabled: false,
  }),
}));
vi.mock("../trainer/TrainerContext", () => ({
  useTrainer: () => ({
    introSeen: () => mocks.introSeen,
    openIntro: mocks.openIntro,
    blockedReason: mocks.blockedReason,
    note: mocks.note,
  }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.introSeen = true;
  mocks.running = false;
  mocks.blockedReason = "";
  mocks.note = "";
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

it.each([undefined, 2])(
  "запрашивает подтверждение запуска ступени %s; отмена не запускает",
  async (step) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const click = async (text: string) => {
      const button = [...host.querySelectorAll("button")].find(
        (b) => b.textContent === text,
      )!;
      await act(async () => button.click());
    };
    try {
      await act(async () => root.render(<PracticeButton step={step} />));
      await click("Тренировка");
      expect(host.textContent).toContain("Запустить тренировку?");
      expect(mocks.start).not.toHaveBeenCalled();
      await click("Отмена");
      expect(host.querySelector('[role="dialog"]')).toBeNull();
      expect(mocks.start).not.toHaveBeenCalled();
      await click("Тренировка");
      await click("Запустить");
      expect(mocks.start).toHaveBeenCalledExactlyOnceWith({
        step,
        scenario: undefined,
        again: undefined,
      });
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  },
);

it("первое знакомство тоже открывается только после подтверждения", async () => {
  mocks.introSeen = false;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<PracticeButton />));
    await act(async () => host.querySelector("button")!.click());
    expect(mocks.openIntro).not.toHaveBeenCalled();
    const confirm = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Запустить",
    )!;
    await act(async () => confirm.click());
    expect(mocks.openIntro).toHaveBeenCalledOnce();
    expect(mocks.start).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("не дублирует сообщение запуска Provider, но показывает причину блокировки", async () => {
  mocks.note = "Не удалось начать тренировку.";
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<PracticeAvailabilityNotice />));
    expect(host.textContent).toBe("");
    mocks.blockedReason = "Идёт занятие преподавателя.";
    await act(async () => root.render(<PracticeAvailabilityNotice />));
    expect(host.textContent).toBe(mocks.blockedReason);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
