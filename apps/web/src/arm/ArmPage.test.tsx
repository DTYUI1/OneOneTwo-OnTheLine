import { beforeEach, describe, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactNode, useState } from "react";
import { QueryClient } from "@tanstack/react-query";
import { ArmPage } from "./ArmPage";
import { PhoneWindow } from "./phone/PhoneWindow";
import { PAGE_SIZES } from "./listModel";
import type { Card } from "../shared/api";
import type { PhoneLine } from "./phone/cardLineState";
import type { HoldEffect } from "./phone/hold";

const mocks = vi.hoisted(() => ({
  path: "",
  cards: [] as Card[],
  get: vi.fn(),
  queries: vi.fn(),
  enqueue: vi.fn(),
  hold: vi.fn(),
}));
// Проверяем сборку страницы и её обработчики без монтирования дочерних окон.
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: vi.fn((value: unknown) => [value, vi.fn()]),
  useRef: (current: unknown) => ({ current }),
  useMemo: (compute: () => unknown) => compute(),
  useCallback: (callback: unknown) => callback,
  useEffect: vi.fn(),
  useLayoutEffect: vi.fn(),
}));
vi.mock("react-router-dom", () => ({
  useLocation: () => ({}),
  useNavigate: () => vi.fn(),
  useParams: () => ({ "*": mocks.path }),
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data:
      queryKey[0] === "cards"
        ? mocks.cards
        : queryKey[0] === "sessions"
          ? [
              {
                id: "session",
                status: "running",
                settings_snapshot: { final_shift: true },
              },
            ]
          : queryKey[0] === "services"
            ? []
            : null,
  }),
  useQueries: (options: unknown) => {
    mocks.queries(options);
    return [];
  },
}));
vi.mock("../shared/api", () => ({ api: { GET: mocks.get } }));
vi.mock("../shared/session", () => ({
  useSession: () => ({
    user: { id: "user" },
    realtime: { enqueue: mocks.enqueue },
  }),
}));
vi.mock("../shared/help/HelpProvider", () => ({ useHelpGuide: vi.fn() }));
// Регистрация кнопки в общем UI не участвует в проверках страницы без renderer.
vi.mock("../shared/WorkflowGuide", async (original) => ({
  ...(await original<typeof import("../shared/WorkflowGuide")>()),
  useWorkflowExtra: vi.fn(),
}));
// Видимость украшения справки также не требует подписки без React renderer.
vi.mock("../shared/mascot/Mascot", async (original) => ({
  ...(await original<typeof import("../shared/mascot/Mascot")>()),
  useMascotShown: () => false,
}));
vi.mock("./help/useHelpEnabled", () => ({ useHelpEnabled: () => false }));
vi.mock("./useNow", () => ({ useNow: () => 1000 }));
vi.mock("./useParticipant", () => ({
  useParticipant: () => ({ canAct: true }),
}));
vi.mock("./useCardActions", () => ({ useCardActions: () => ({}) }));
vi.mock("./tools/toolsStore", () => ({
  useToolsStore: () => ({ pinned: [] }),
  pinnedFirst: (rows: unknown) => rows,
}));
vi.mock("./phone/useHold", () => ({
  useHold: (effect: unknown) => {
    mocks.hold(effect);
    return { state: { held: [], dropped: [] } };
  },
}));
vi.mock("./phone/PhoneWindow", async (original) => ({
  ...(await original<typeof import("./phone/PhoneWindow")>()),
  usePhoneLines: () => ({ rings: [], missed: [], controls: [] }),
  usePhoneState: () => ({ call: null, rings: [], controls: [] }),
}));

function propsOf(
  node: ReactNode,
  type: unknown,
): Record<string, unknown> | null {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode }>(child)) continue;
    if (child.type === type) return child.props;
    const found = propsOf(child.props.children, type);
    if (found) return found;
  }
  return null;
}

const card = {
  id: "final-card",
  session_id: "session",
  state: "responding",
  source: { number: "70005101" },
  current: {},
} as Card;

function phoneProps(line: PhoneLine | null) {
  vi.mocked(useState)
    .mockReturnValueOnce([null, vi.fn()])
    .mockReturnValueOnce(["", vi.fn()])
    // Пагинация реестра в dev добавила два состояния перед switching и phoneLine.
    .mockReturnValueOnce([0, vi.fn()])
    .mockReturnValueOnce([PAGE_SIZES[0], vi.fn()])
    .mockReturnValueOnce([null, vi.fn()])
    .mockReturnValueOnce([line, vi.fn()]);
  return propsOf(ArmPage(), PhoneWindow);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.path = "";
  mocks.cards = [card];
});

describe("отбой удержания закрытой карточки (PR3-03)", () => {
  it("не пропускает завершающий отбой и доклад службы мимо outbox", () => {
    mocks.cards = [{ ...card, state: "completed" }];
    ArmPage();
    const effect = mocks.hold.mock.calls[0][0] as (effect: HoldEffect) => void;
    effect({
      type: "hangup",
      cardId: card.id,
      callId: "service-call",
      report: {
        callId: "service-call",
        choices: ["full"],
        modes: ["option"],
        parts: [["who"]],
        loudness: [null],
        voiceFailures: 0,
        registration: null,
      },
    });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      card.id,
      expect.objectContaining({
        type: "call_hangup",
        payload: expect.objectContaining({
          call_id: "service-call",
          report_choices: ["full"],
        }),
      }),
    );
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("фоновые карточки (PR3-08)", () => {
  it("HTTP-ошибка остаётся ошибкой и не кеширует пустой список навсегда", async () => {
    ArmPage();
    const {
      queries: [query],
    } = mocks.queries.mock.calls[0][0];
    const client = new QueryClient();
    mocks.get.mockResolvedValueOnce({ error: { message: "Нет связи" } });
    await expect(client.fetchQuery(query)).rejects.toThrow("Нет связи");
    expect(client.getQueryState(query.queryKey)?.status).toBe("error");
    mocks.get.mockResolvedValueOnce({ data: [{ id: "background-card" }] });
    await expect(client.fetchQuery(query)).resolves.toEqual([
      { id: "background-card" },
    ]);
    expect(mocks.get).toHaveBeenCalledTimes(2);
    client.clear();
  });
  it("действительный пустой список остаётся успешным ответом", async () => {
    ArmPage();
    const {
      queries: [query],
    } = mocks.queries.mock.calls[0][0];
    mocks.get.mockResolvedValueOnce({ data: [] });
    await expect(
      query.queryFn({ signal: new AbortController().signal }),
    ).resolves.toEqual([]);
  });
});

describe("телефон финальной смены в реестре (PR3-01)", () => {
  it("не скрывает независимую линию, пока обучаемый ищет карточку бригады", () => {
    expect(
      phoneProps({ cardId: card.id, openedAt: null, talked: true })?.away,
    ).toBe(false);
  });
  it("не раскрывает обычный телефон без карточки и без независимой линии", () => {
    expect(phoneProps(null)?.away).toBe(true);
  });
  it("оставляет телефон открытой карточки доступным", () => {
    mocks.path = `cards/${card.id}`;
    expect(phoneProps(null)?.away).toBe(false);
  });
});
