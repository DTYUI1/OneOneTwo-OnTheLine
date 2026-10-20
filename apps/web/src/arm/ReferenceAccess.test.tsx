// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { ReferenceAccess } from "./ReferenceAccess";
import { ReferencePanel } from "./ReferencePanel";
import { addedReferences, type LessonMaterials } from "./referenceModel";
import type { ServerEvent } from "../shared/api";
const mocks = vi.hoisted(() => ({ get: vi.fn(), subscribe: vi.fn() }));
vi.mock("../shared/api", () => ({ api: { GET: mocks.get } }));
vi.mock("../shared/session", () => ({
  useSession: () => ({ realtime: { subscribe: mocks.subscribe } }),
}));
const file = (id: string, version = 1) => ({
  id,
  version,
  title: `Памятка ${id}`,
  purpose: "reference" as const,
  media_type: "text/plain" as const,
  size_bytes: 10,
  sha256: "a".repeat(64),
  created_at: "2026-10-20T10:00:00Z",
});
const lesson = (
  id: string,
  current: boolean,
  files = [file(id)],
): LessonMaterials => ({
  session_id: id,
  title: `Занятие ${id}`,
  date: "2026-10-20T10:00:00Z",
  is_current: current,
  materials: files,
});
let root: Root,
  host: HTMLDivElement,
  client: QueryClient,
  listener: (event: ServerEvent) => void;
let data: LessonMaterials[];
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  data = [lesson("current", true), lesson("past", false, [file("current", 1)])];
  mocks.get.mockImplementation(async () => ({ data: structuredClone(data) }));
  mocks.subscribe.mockImplementation((callback) => {
    listener = callback;
    return () => {};
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.clearAllMocks();
});
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
async function mount(node: React.ReactNode) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>{node}</QueryClientProvider>,
    ),
  );
  await flush();
}
function button(text: string) {
  const found = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === text,
  );
  expect(found).toBeTruthy();
  return found!;
}
function CardWorkspace() {
  const [comment, setComment] = useState("");
  const location = useLocation();
  return (
    <>
      <ReferenceAccess sessionId="current" running />
      <input
        aria-label="Комментарий карточки"
        value={comment}
        onChange={(event) => setComment(event.target.value)}
      />
      <output>{location.pathname}</output>
    </>
  );
}
it("открывает справку поверх карточки, сохраняет введённый комментарий и адрес страницы", async () => {
  await mount(
    <MemoryRouter initialEntries={["/arm/cards/test"]}>
      <CardWorkspace />
    </MemoryRouter>,
  );
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "Адрес уточнён, бригада направлена");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Справка (1)").click());
  await flush();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.querySelector("output")?.textContent).toBe("/arm/cards/test");
  expect(host.querySelector("input")).toBe(input);
  expect(input.value).toBe("Адрес уточнён, бригада направлена");
  await act(async () =>
    (
      document.querySelector(
        '[aria-label="Закрыть справку"]',
      ) as HTMLButtonElement
    ).click(),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(input.value).toBe("Адрес уточнён, бригада направлена");
});
it("разделяет текущие и прошлые занятия, прошлые по умолчанию свёрнуты", async () => {
  data = [
    lesson("current", true, [file("shared", 2)]),
    lesson("past", false, [file("shared", 1)]),
  ];
  await mount(<ReferencePanel onClose={() => {}} />);
  const past = [...host.querySelectorAll("details")].find((d) =>
    d.querySelector("summary")?.textContent?.startsWith("С прошлых"),
  )!;
  expect(past.open).toBe(false);
  expect(past.textContent).toContain("Занятие past");
  expect(past.textContent).toContain("версия 1");
  expect(host.textContent).toContain("версия 2");
});
it("после realtime-события обновляет счётчик и сообщает о новом файле без повторов", async () => {
  await mount(<ReferenceAccess running sessionId="current" />);
  expect(document.querySelector('[role="status"]')?.textContent).toBe("");
  data = [
    lesson("current", true, [file("current"), file("new")]),
    lesson("past", false),
  ];
  await act(async () =>
    listener({ type: "session.materials_changed" } as ServerEvent),
  );
  await flush();
  expect(button("Справка (2)")).toBeTruthy();
  expect(document.querySelector('[role="status"]')?.textContent).toBe(
    "Преподаватель добавил материал: Памятка new",
  );
  expect(addedReferences(data, structuredClone(data))).toEqual([]);
  expect(addedReferences(undefined, data)).toEqual([]);
  expect(addedReferences([lesson("another", true)], data)).toEqual([]);
});
it("показывает понятную подпись без текущего занятия и кнопку с нулём при пустом занятии", async () => {
  data = [lesson("current", true, [])];
  await mount(<ReferenceAccess running />);
  expect(button("Справка (0)")).toBeTruthy();
  await act(async () => button("Справка (0)").click());
  await flush();
  expect(document.body.textContent).toContain(
    "Преподаватель пока не прикрепил материалы к этому занятию.",
  );
  data = [];
  await act(async () => listener({ type: "session.finished" } as ServerEvent));
  await flush();
  expect(document.body.textContent).toContain(
    "Сейчас у вас нет идущего занятия.",
  );
});

it("возвращает Tab от последнего видимого summary к закрытию, минуя скрытые ссылки", async () => {
  // happy-dom не считает геометрию; моделируем видимость закрытых details.
  const rects = vi
    .spyOn(HTMLElement.prototype, "getClientRects")
    .mockImplementation(function (this: HTMLElement) {
      const details = this.closest("details");
      const visible = !details || details.open || this.tagName === "SUMMARY";
      return (visible
        ? [new DOMRect(0, 0, 100, 20)]
        : []) as unknown as DOMRectList;
    });
  try {
    await mount(<ReferenceAccess running />);
    await act(async () => button("Справка (1)").click());
    await flush();
    const dialog = document.querySelector('[role="dialog"]')!;
    const summaries = [...dialog.querySelectorAll("summary")];
    const close = dialog.querySelector("button")!;
    summaries.at(-1)!.focus();
    await act(async () =>
      summaries
        .at(-1)!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
        ),
    );
    expect(document.activeElement).toBe(close);
    await act(async () =>
      close.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
        }),
      ),
    );
    expect(document.activeElement).toBe(summaries.at(-1));
  } finally {
    rects.mockRestore();
  }
});

it("закрывает справку по Esc после потери фокуса и не передаёт Esc карточке", async () => {
  await mount(<ReferenceAccess running />);
  const cardEscape = vi.fn();
  window.addEventListener("keydown", cardEscape);
  try {
    for (const outside of [false, true]) {
      const opener = button("Справка (1)");
      opener.focus();
      await act(async () => opener.click());
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
      if (outside) dialog.blur();
      else dialog.querySelector("button")!.focus();
      await act(async () =>
        document.activeElement!.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(opener);
    }
    expect(cardEscape).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("keydown", cardEscape);
  }
});

it("после потери фокуса Esc закрывает только верхний диалог", async () => {
  const { Dialog } = await import("./Dialog");
  const outerClose = vi.fn();
  const innerClose = vi.fn();
  await mount(
    <Dialog label="Нижнее окно" onClose={outerClose}>
      <Dialog label="Верхнее окно" onClose={innerClose}>
        Подтверждение
      </Dialog>
    </Dialog>,
  );
  (document.activeElement as HTMLElement).blur();
  await act(async () => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(innerClose).toHaveBeenCalledOnce();
  expect(outerClose).not.toHaveBeenCalled();
});
