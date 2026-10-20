import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TrainerProvider, useTrainer, type TrainerApi } from "./TrainerContext";
import { trainerStore, type CardVoice } from "./trainerStore";
import { doneStages, sessionMode, setSessionMode } from "./stages";
import { stopDemo } from "./autopilot";

const mocks = vi.hoisted(() => ({
  practice: { note: "", running: false, disabled: false, start: vi.fn() },
  post: vi.fn(),
  invalidate: vi.fn(),
  states: [] as unknown[],
  stateIndex: 0,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = mocks.stateIndex++;
    if (!(index in mocks.states)) mocks.states[index] = initial;
    return [
      mocks.states[index],
      (value: unknown) => {
        mocks.states[index] = value;
      },
    ];
  },
}));
vi.mock("../practice/usePracticeStart", () => ({
  usePracticeStart: () => mocks.practice,
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: mocks.invalidate,
    setQueryData: vi.fn(),
  }),
}));
vi.mock("../../shared/api", () => ({
  api: { POST: mocks.post },
  csrfToken: () => "csrf",
}));
vi.mock("./autopilot", () => ({ startDemo: vi.fn(), stopDemo: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.practice.note = "";
  mocks.states = [];
  mocks.stateIndex = 0;
  trainerStore.setCard(null);
  trainerStore.setDemo(null);
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});

// Провайдер без SessionContext: пользователя нет, отметки этапов — под пустым ключом.
const NO_USER = "";

function trainer() {
  let api: TrainerApi | null = null;
  function Read() {
    api = useTrainer();
    return null;
  }
  mocks.stateIndex = 0;
  const html = renderToStaticMarkup(
    <TrainerProvider onReview={vi.fn()}>
      <Read />
    </TrainerProvider>,
  );
  if (!api) throw new Error("Нет провайдера");
  return { api: api as TrainerApi, html };
}

function watching() {
  trainerStore.setCard({
    cardId: "card",
    sessionId: "session",
    practice: true,
    closed: false,
    canAct: true,
  } as CardVoice);
  trainerStore.setDemo({
    cardId: "card",
    expert: false,
    paused: false,
    over: false,
    text: "Показ",
  });
  setSessionMode("session", "watch");
}

describe("перехват только после подтверждения сервера (PR3-07)", () => {
  it("не отмечает этап пройденным до ответа и отправляет один запрос", async () => {
    watching();
    let resolve!: (value: unknown) => void;
    mocks.post.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { api } = trainer();
    const pending = api.takeOver();
    expect(sessionMode("session")).toBe("watch");
    expect(doneStages(NO_USER).has("watch")).toBe(false);
    expect(trainerStore.get().demo?.paused).toBe(true);
    void api.takeOver();
    expect(mocks.post).toHaveBeenCalledTimes(1);
    resolve({ data: { id: "session", settings_snapshot: { demo: false } } });
    await pending;
    expect(sessionMode("session")).toBe("together");
    expect(doneStages(NO_USER).has("watch")).toBe(true);
    expect(stopDemo).toHaveBeenCalledTimes(1);
  });
  it("новый запуск убирает старую ошибку перехвата и показывает текущую обратную связь", async () => {
    watching();
    mocks.post.mockResolvedValue({
      error: { message: "Сервер отказал" },
      response: { status: 409 },
    });
    await trainer().api.takeOver();
    trainer().api.startStage("solo");
    mocks.practice.note = "Тренировка запущена. Карточка откроется сама.";
    expect(trainer().html).toContain(mocks.practice.note);
    expect(trainer().html).not.toContain("Не удалось взять управление");
  });
  it.each(["HTTP", "сеть"])(
    "ошибка %s оставляет показ и видимое сообщение",
    async (kind) => {
      watching();
      if (kind === "HTTP")
        mocks.post.mockResolvedValue({
          error: { message: "Сервер отказал" },
          response: { status: 409 },
        });
      else mocks.post.mockRejectedValue(new Error("Сеть недоступна"));
      await trainer().api.takeOver();
      expect(sessionMode("session")).toBe("watch");
      expect(doneStages(NO_USER).has("watch")).toBe(false);
      expect(stopDemo).not.toHaveBeenCalled();
      expect(trainerStore.get().demo?.paused).toBe(kind === "сеть");
      expect(trainer().html).toContain(
        kind === "сеть" ? "Показ на паузе" : "Не удалось взять управление",
      );
    },
  );
});

describe("обратная связь запуска вне первой ступени (PR3-06)", () => {
  it.each([
    "Не удалось начать тренировку. Проверьте соединение.",
    "Тренировка запущена. Карточка откроется сама.",
    "Карточка тренировки ещё не пришла. Попробуйте позже.",
  ])("видна без StageSwitch на ступени 3: %s", (note) => {
    mocks.practice.note = note;
    const html = renderToStaticMarkup(
      <TrainerProvider onReview={vi.fn()}>
        <main>Разбор</main>
      </TrainerProvider>,
    );
    expect(html).toContain(note);
    expect(html).toContain('role="status"');
  });
});
