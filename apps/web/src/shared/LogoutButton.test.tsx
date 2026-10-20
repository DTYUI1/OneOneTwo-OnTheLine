// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LogoutButton } from "./LogoutButton";
const api = vi.hoisted(() => ({ GET: vi.fn() }));
vi.mock("./api", () => ({ api }));
let root: Root, host: HTMLDivElement;
const logout = vi.fn();
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  api.GET.mockResolvedValue({ data: [] });
  logout.mockResolvedValue(true);
  await act(async () =>
    root.render(<LogoutButton role="trainee" onLogout={logout} />),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.resetAllMocks();
});
async function click(text: string) {
  const button = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === text,
  );
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
it("без занятия выходит только после подтверждения", async () => {
  await click("Выйти");
  expect(logout).not.toHaveBeenCalled();
  await click("Остаться");
  expect(logout).not.toHaveBeenCalled();
  await click("Выйти");
  await click("Да, выйти");
  expect(logout).toHaveBeenCalledOnce();
});
it("при занятии требует второго подтверждения, отмена сохраняет вход", async () => {
  api.GET.mockResolvedValue({ data: [{ status: "running" }] });
  await click("Выйти");
  await click("Да, выйти");
  expect(logout).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("У вас идёт занятие.");
  await click("Остаться");
  expect(logout).not.toHaveBeenCalled();
  await click("Выйти");
  await click("Да, выйти");
  await click("Всё равно выйти");
  expect(logout).toHaveBeenCalledOnce();
});
it("при ошибке проверки не выходит и позволяет повторить", async () => {
  api.GET.mockResolvedValue({ error: { message: "offline" } });
  await click("Выйти");
  await click("Да, выйти");
  expect(logout).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "Не удалось проверить",
  );
  api.GET.mockResolvedValue({ data: [{ status: "finished" }] });
  await click("Да, выйти");
  expect(logout).toHaveBeenCalledOnce();
});
it("Escape отменяет второй шаг", async () => {
  api.GET.mockResolvedValue({ data: [{ status: "running" }] });
  await click("Выйти");
  await click("Да, выйти");
  await act(async () =>
    document
      .querySelector('[role="dialog"]')!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(logout).not.toHaveBeenCalled();
});

it("личная тренировка running не требует второго подтверждения", async () => {
  api.GET.mockResolvedValue({
    data: [
      { status: "running", kind: "practice" },
      { status: "finished", kind: "lesson" },
    ],
  });
  await click("Выйти");
  await click("Да, выйти");
  expect(logout).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it("при тренировке и активном занятии преподавателя требует второго подтверждения", async () => {
  api.GET.mockResolvedValue({
    data: [
      { status: "running", kind: "practice" },
      { status: "running", kind: "lesson" },
    ],
  });
  await click("Выйти");
  await click("Да, выйти");
  expect(logout).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("У вас идёт занятие.");
});
