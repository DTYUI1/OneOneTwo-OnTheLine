import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { type ReactNode } from "react";
import { TrainerCoach } from "./TrainerCoach";
import { trainerStore, type CardVoice } from "./trainerStore";

const mocks = vi.hoisted(() => ({ busy: false, takingOver: false }));
vi.mock("./TrainerContext", () => ({
  useTrainer: () => ({
    mode: "watch",
    busy: mocks.busy,
    takingOver: mocks.takingOver,
    takeOver: vi.fn(),
  }),
}));
// SSR проверяет управление показом без клиентского хранилища видимости наставника.
// Фигура и голос проверяются отдельно в живом браузере, остальные экспорты реальные.
vi.mock("../../shared/mascot/Mascot", async (original) => ({
  ...(await original<typeof import("../../shared/mascot/Mascot")>()),
  useMascotShown: () => false,
}));
vi.mock("react-dom", () => ({ createPortal: (child: ReactNode) => child }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: vi.fn(react.useState),
    useLayoutEffect: vi.fn(),
  };
});

const card = {
  cardId: "card",
  sessionId: "session",
  practice: true,
  closed: false,
  canAct: true,
  check: null,
  clarity: null,
  heard: null,
  tip: null,
} as CardVoice;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.busy = false;
  mocks.takingOver = false;
  vi.stubGlobal("document", { body: {} });
  trainerStore.setCard(card);
  trainerStore.setDemo({
    cardId: card.cardId,
    expert: false,
    paused: false,
    over: false,
    text: "Показ",
  });
});
afterEach(() => {
  trainerStore.setCard(null);
  trainerStore.setDemo(null);
  vi.unstubAllGlobals();
});

const html = () =>
  renderToStaticMarkup(<TrainerCoach cards={[]} now={0} reactionS={30} />);

describe("управление показом всегда доступно (PR3-02)", () => {
  it("во время показа нельзя скрыть единственные кнопки управления", () => {
    expect(html()).toContain("Беру управление");
    expect(html()).toContain("Пауза");
    expect(html()).not.toContain(
      'aria-label="Скрыть подсказку до следующего шага"',
    );
  });
  it("спрятать подсказку нельзя и вне показа (капитан, 19.10)", () => {
    trainerStore.updateDemo({ over: true });
    expect(html()).not.toContain("Скрыть подсказку");
  });
  it("ожидание сервера блокирует повторный перехват и снятие паузы (PR3-07)", () => {
    mocks.takingOver = true;
    trainerStore.updateDemo({ paused: true });
    expect(html().match(/disabled=""/g)).toHaveLength(2);
  });
});
