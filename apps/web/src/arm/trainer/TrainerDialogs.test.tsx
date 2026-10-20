import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TrainerDialogs } from "./TrainerDialogs";

// «Тренировка с Николаем Сергеевичем» (капитан, 20.10): портрет в шапке открывает выбор этапа
// на любой ступени; все три этапа — учебная карточка ступени 1.
const mocks = vi.hoisted(() => ({ done: new Set<string>(["watch"]) }));
vi.mock("./TrainerContext", () => ({
  useTrainer: () => ({
    dialog: { kind: "mentor" },
    done: () => mocks.done,
    busy: false,
    blockedReason: "",
    startStage: vi.fn(),
    closeDialog: vi.fn(),
  }),
}));
// SSR без клиентского хранилища: фигура выключена, окно — текстом.
vi.mock("../../shared/mascot/Mascot", async (original) => ({
  ...(await original<typeof import("../../shared/mascot/Mascot")>()),
  useMascotShown: () => false,
}));

const html = (pathStep: number | undefined) =>
  renderToStaticMarkup(
    <TrainerDialogs
      service={null}
      workstation={null}
      reactionS={30}
      pathStep={pathStep}
      onReview={vi.fn()}
      onMenu={vi.fn()}
    />,
  );

describe("тренировка с Николаем Сергеевичем", () => {
  it("три этапа словами, пройденный — с ✓, следующий отмечен", () => {
    const page = html(undefined);
    expect(page).toContain("Тренировка с Николаем Сергеевичем");
    expect(page).toContain("✓ 1. Смотрю");
    expect(page).toContain("2. Вместе");
    expect(page).toContain("3. Сам");
    expect(page).toContain("Та же учебная карточка без подсказок");
    expect(page).toMatch(/aria-current="step"[^>]*>[^<]*<b>2\. Вместе/);
  });

  it("на ступени 1 — когда она зачтётся; дальше — повторение", () => {
    expect(html(undefined)).toContain(
      "Ступень 1 «Интерфейс и статусы» зачтётся",
    );
    expect(html(3)).toContain("Ступень 1 у вас уже зачтена");
  });

  it("включить наставника можно здесь же", () => {
    expect(html(2)).toContain("Николай Сергеевич в подсказках");
  });
});
